import PostalMime from 'postal-mime';
import constant from '../const/constant';
import { EmailConst } from '../entity/email';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';
import attService from './att-service';
import emailService from './email-service';
import rspamdService from './rspamd-service';
import { getR2Domain } from '../utils/r2-utils';

// Body-size guard for the Rspamd classifier. Anything larger is
// rejected before we even start — the upstream classifier has its
// own limit, and pushing a multi-megabyte attachment dump
// through it just amplifies the receive-pipeline latency on
// borderline messages. 25 MB is well above the practical size
// for any text-only spam check payload.
const MAX_RSPAMD_BODY_BYTES = 25 * 1024 * 1024;

export async function email(message, env, ctx) {
	try {
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

		// Async Rspamd check. Runs after the SMTP receive has
		// already returned (ctx.waitUntil is the platform's
		// "don't block the request on this" hook). On
		// `action === "reject"` the row is moved out of the
		// live `email` table into `junk_email` — see
		// `emailService.markAsJunk` for the safety reasoning.
		if (ctx && typeof ctx.waitUntil === 'function') {
			ctx.waitUntil(
				runSpamCheck({
					env,
					emailId: emailRow.id,
					rawBody: rawText,
					fromEmail: email.from.address,
					toEmail: message.to,
				}),
			);
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
