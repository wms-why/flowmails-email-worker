import PostalMime from 'postal-mime';
import constant from '../const/constant';
import { EmailConst } from '../entity/email';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';
import attService from './att-service';
import emailService from './email-service';
import eventIngestService from './event-ingest-service';
import routeService from './route-service';
import rspamdService from './rspamd-service';
import { getR2Domain } from '../utils/r2-utils';

// Body-size guard for the Rspamd classifier. Anything larger is
// rejected before we even start — the upstream classifier has its
// own limit, and pushing a multi-megabyte attachment dump
// through it just amplifies the receive-pipeline latency on
// borderline messages. 25 MB is well above the practical size
// for any text-only spam check payload.
const MAX_RSPAMD_BODY_BYTES = 25 * 1024 * 1024;

// 550 5.1.1 是标准的「用户不存在」，比 5.7.1 (policy) 更贴近真实
// 原因，也避免把「这个域名用了白名单」这件事透给发件方。
const ROUTE_REJECT_REASON = '550 5.1.1 No such user at this domain';

export async function email(message, env, ctx) {
	try {
		// 路由判定必须**先于任何正文解析**：`message.raw` 是一次性
		// ReadableStream，这里早退还能顺带省掉大附件的 arrayBuffer。
		// Cloudflare 侧现在对该域名只保留一条 catch-all → worker 的
		// 规则，「哪些 localpart 收信」完全由 KV 里的路由表决定
		// (见 `route-service.js`)。判定失败一律放行
		// (route-service 内部 fail-open)，基础设施抖动不会变成丢信。
		const decision = await routeService.decide(env, message.to);
		if (decision.action === 'reject') {
			message.setReject(ROUTE_REJECT_REASON);
			return;
		}

		// Read the raw RFC822 source ONCE into a string so we can
		// (a) feed it to PostalMime for parsing and (b) hand it
		// to the Rspamd classifier later without re-reading
		// `message.raw` (which is a one-shot ReadableStream).
		const rawText = await readRawBody(message);

		const email = await PostalMime.parse(rawText);
		const toName = emailUtils.getName(message.to);
		if (!email.to) {
			email.to = [{ address: message.to, name: toName }];
		}

		const params = {
			toEmail: message.to,
			toName,
			fromEmail: email.from.address,
			fromName: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject || '',
			content: email.html || '',
			text: email.text || '',
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo || '',
			references: email.references || '',
			messageId: email.messageId || '',
			status: EmailConst.status.SAVING,
		};

		const attachments = [];
		const cidAttachments = [];

		for (const item of email.attachments) {
			const attachment = { ...item };
			attachment.key =
				constant.ATTACHMENT_PREFIX + (await fileUtils.getBuffHash(attachment.content)) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		const r2domain = getR2Domain(message.to);

		let emailRow = await emailService.save(env, params, cidAttachments, r2domain);

		attachments.forEach((attachment) => {
			attachment.emailId = emailRow.id;
		});

		if (attachments.length > 0) {
			await attService.insertBatch({ env }, attachments);
		}

		emailRow = await emailService.completeReceive(env, EmailConst.status.RECEIVE, emailRow.id);

		// Report the accepted message to the platform's durable event
		// log — the producer side of `POST /api/events/ingest`. The body
		// and attachments stay in this worker's D1/R2. `reportInbound`
		// never throws by design; the catch keeps a programming error
		// from turning a successful receive into a failed one.
		const eventReport = eventIngestService
			.reportInbound(env, {
				messageId: params.messageId,
				recipient: message.to,
				sender: params.fromEmail,
				subject: params.subject,
			})
			.catch((err) => {
				console.warn('[event-ingest] unexpected failure:', err instanceof Error ? err.message : err);
			});

		// Async work after the SMTP return. The Rspamd check may move
		// the row out of the live `email` table into `junk_email` on
		// `action === "reject"` — see `emailService.markAsJunk` for the
		// safety reasoning. The event report is independent and fires in
		// parallel: the log records that the message arrived, which is
		// true whether or not the classifier later files it as junk.
		if (ctx && typeof ctx.waitUntil === 'function') {
			ctx.waitUntil(eventReport);
			ctx.waitUntil(
				runSpamCheck({
					env,
					emailId: emailRow.id,
					rawBody: rawText,
					fromEmail: email.from.address,
					toEmail: message.to,
				}),
			);
		} else {
			await eventReport;
		}

		//转发到其他邮箱
		// if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {
		// 	const emails = forwardEmail.split(',');

		// 	await Promise.all(
		// 		emails.map(async (email) => {
		// 			try {
		// 				await message.forward(email);
		// 			} catch (e) {
		// 				console.error(`转发邮箱 ${email} 失败：`, e);
		// 			}
		// 		}),
		// 	);
		// }
	} catch (e) {
		console.error('邮件接收异常: ', e);
	}
}

// Read `message.raw` (a one-shot ReadableStream) into a UTF-8
// string. PostalMime accepts a string as well as a stream, so we
// parse from the cached text. A size guard avoids pathological
// payloads (the classifier has its own limit; rejecting here
// keeps the receive path from queuing a giant request).
async function readRawBody(message) {
	const resp = new Response(message.raw);
	const buf = await resp.arrayBuffer();
	if (buf.byteLength > MAX_RSPAMD_BODY_BYTES) {
		throw new Error(`raw body too large: ${buf.byteLength} bytes`);
	}
	return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

// Best-effort Rspamd check, scheduled via `ctx.waitUntil` so it
// never delays the SMTP return. Failures are logged but never
// propagated — the email is already saved and the user shouldn't
// lose it because the classifier hiccupped.
async function runSpamCheck({ env, emailId, rawBody, fromEmail, toEmail }) {
	try {
		const result = await rspamdService.checkEmail(env, { rawBody, fromEmail, toEmail });
		if (!result.isJunk) {
			return;
		}
		await emailService.markAsJunk(env, emailId, result);
	} catch (err) {
		console.error('spam check failed:', err instanceof Error ? err.message : err);
	}
}
