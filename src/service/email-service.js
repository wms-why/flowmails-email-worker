import { and, asc, desc, eq, gt, inArray, count, lt, sql } from 'drizzle-orm';
import { parseHTML } from 'linkedom';
import email from '../entity/email';
import { EmailConst } from '../entity/email';
import orm from '../entity/orm';
import { t } from '../i18n/i18n';
import BizError from '../utils/biz-error';
import emailUtils from '../utils/email-utils';
import attService from './att-service';
import cfEmailService from './cf-email-service';
import starService from './star-service';
import unreadcountService from './unreadcount-service';
import { getR2Domain } from '../utils/r2-utils';
import verifyUtils from '../utils/verify-utils';

const emailService = {
	async list(c, params) {
		let { size } = params;
		const { type, domain, emailId, to } = params;

		size = Number(size);
		// type 统一使用字符串
		const typeValue = type === 'send' ? 'send' : 'receive';

		if (size > 30) {
			size = 30;
		}

		const conditions = [eq(email.type, typeValue)];

		// 处理 emailId：确保是有效的数字
		if (emailId) {
			conditions.push(gt(email.id, Number(emailId)));
		}

		// Domain filter. The web proxy always passes a bare domain
		// name (no `@`), so we filter on the indexed `to_domain` /
		// `from_domain` virtual column — an equality that hits the
		// partial B-tree instead of falling back to a `LIKE '%@…'`
		// suffix scan. `to_domain` is the recipient's domain for
		// received mail; `from_domain` is the sender's own domain
		// for sent mail. Both columns are auto-derived from the
		// corresponding address at write time, so the filter and
		// the index never drift.
		if (domain) {
			const domainColumn = typeValue === 'send' ? email.fromDomain : email.toDomain;
			conditions.push(eq(domainColumn, domain));
		}

		// Localpart picker filter. The web side passes each
		// selected local part (e.g. `"support"`) as a separate
		// `to=` parameter; the proxy composes the full address
		// before it reaches us. Inside the worker we filter on the
		// `to_local` / `from_local` virtual column so the query
		// can range-scan within `(to_domain, to_local)` on the
		// compound partial index instead of pulling whole
		// addresses. The split is the same shape as the index.
		if (Array.isArray(to) && to.length > 0) {
			const toList = to.map((s) => String(s ?? '').trim()).filter(Boolean);
			if (toList.length > 0) {
				const localColumn = typeValue === 'send' ? email.fromLocal : email.toLocal;
				conditions.push(inArray(localColumn, toList));
			}
		}

		const listQuery = orm(c.env)
			.select()
			.from(email)
			.where(and(...conditions))
			.orderBy(desc(email.id))
			.limit(size)
			.all();

		// 统计和最新邮件查询需要添加 domain 条件
		const totalQuery = orm(c.env)
			.select({ total: count(email.id) })
			.from(email)
			.where(and(...conditions))
			.get();

		const [listResult, totalRow] = await Promise.all([listQuery, totalQuery]);
		let list = listResult;

		const emailIds = list.map((item) => item.id);

		// 单独查询 star 记录
		const starList = await starService.selectByEmailIds(c, emailIds);
		const starredEmailIds = new Set(starList.map((item) => item.emailId));

		list = list.map((item) => ({
			...item,
			isStar: starredEmailIds.has(item.id) ? 1 : 0,
		}));

		const attsList = await attService.selectByEmailIds(c, emailIds);

		list.forEach((emailRow) => {
			let r2domain = '';
			if (emailRow.type === 'receive') {
				r2domain = getR2Domain(emailRow.toEmail);
			} else if (emailRow.type === 'send') {
				r2domain = getR2Domain(emailRow.fromEmail);
			}

			const atts = attsList.filter((attsRow) => {
				attsRow.url = `https://${r2domain}/${attsRow.key}`;
				return attsRow.emailId === emailRow.id;
			});
			emailRow.attList = atts;
		});

		return { list, total: totalRow.total };
	},

	async thread(c, params) {
		// Conversation thread resolver. Returns a centred window of
		// the chain around the requested row: up to NEIGHBOUR_LIMIT
		// older siblings + the current row + up to NEIGHBOUR_LIMIT
		// newer siblings, in oldest→newest order. The current row's
		// preview fields are overwritten with the full body so the
		// web client doesn't have to splice in the list row — every
		// chain row uses the same preview-named fields uniformly.
		// Older / newer siblings keep the truncated SUBSTR
		// projection (textPreview / contentPreview / bodyTruncated)
		// so non-current rows stay bounded.
		const { emailId, threadId: threadIdHint } = params;
		const numericId = Number(emailId);
		if (!numericId) {
			throw new BizError('emailId is required');
		}

		// Optional threadId hint: when the caller (platform web
		// proxy) already knows the chain anchor — because the list
		// loader surfaced the row's `threadId` — we skip the
		// current-row select. If the hint is missing or the row
		// was an orphan, fall through to the original lookup.
		let threadId = typeof threadIdHint === 'string' && threadIdHint.length > 0 ? threadIdHint : null;
		if (!threadId) {
			const current = await orm(c.env).select({ id: email.id, threadId: email.threadId }).from(email).where(eq(email.id, numericId)).get();
			if (!current) {
				throw new BizError(t('notExistEmailReply'));
			}
			threadId = current.threadId;
		}

		// Orphan fallback: no Message-ID header at receive time →
		// no chain anchor → no siblings can be surfaced. Still
		// return the current row alone so the ReadingPane has at
		// least one bubble.
		if (!threadId) {
			const current = await this.selectById(c, numericId);
			if (!current) {
				throw new BizError(t('notExistEmailReply'));
			}
			const list = await this._hydrateChain(c, [current], [current.id]);
			return { list, total: 1, hasMoreOlder: false, hasMoreNewer: false };
		}

		const NEIGHBOUR_LIMIT = 3;
		const TEXT_PREVIEW_LEN = 500;
		const CONTENT_PREVIEW_LEN = 2048;

		// Older siblings: rows in the same thread whose id is
		// strictly less than the current one. `desc(id)` so the
		// newest-of-older comes back first; we flip it later so the
		// final concat reads oldest→newest. `LIMIT N + 1` lets us
		// detect a fuller chain without a second COUNT.
		const olderPromise = orm(c.env)
			.select({
				id: email.id,
				fromEmail: email.fromEmail,
				fromName: email.fromName,
				toEmail: email.toEmail,
				toName: email.toName,
				subject: email.subject,
				messageId: email.messageId,
				inReplyTo: email.inReplyTo,
				threadId: email.threadId,
				type: email.type,
				status: email.status,
				unread: email.unread,
				createTime: email.createTime,
				textPreview: sql`COALESCE(SUBSTR(${email.text}, 1, ${TEXT_PREVIEW_LEN}), '')`,
				contentPreview: sql`COALESCE(SUBSTR(${email.content}, 1, ${CONTENT_PREVIEW_LEN}), '')`,
				bodyTruncated: sql`CASE WHEN LENGTH(IFNULL(${email.text}, '')) > ${TEXT_PREVIEW_LEN} OR LENGTH(IFNULL(${email.content}, '')) > ${CONTENT_PREVIEW_LEN} THEN 1 ELSE 0 END`,
			})
			.from(email)
			.where(and(eq(email.threadId, threadId), lt(email.id, numericId)))
			.orderBy(desc(email.id))
			.limit(NEIGHBOUR_LIMIT + 1)
			.all();

		// Newer siblings: same thread, id strictly greater. `asc(id)`
		// already gives us oldest-of-newer-first, so the final
		// concat just appends without reversing.
		const newerPromise = orm(c.env)
			.select({
				id: email.id,
				fromEmail: email.fromEmail,
				fromName: email.fromName,
				toEmail: email.toEmail,
				toName: email.toName,
				subject: email.subject,
				messageId: email.messageId,
				inReplyTo: email.inReplyTo,
				threadId: email.threadId,
				type: email.type,
				status: email.status,
				unread: email.unread,
				createTime: email.createTime,
				textPreview: sql`COALESCE(SUBSTR(${email.text}, 1, ${TEXT_PREVIEW_LEN}), '')`,
				contentPreview: sql`COALESCE(SUBSTR(${email.content}, 1, ${CONTENT_PREVIEW_LEN}), '')`,
				bodyTruncated: sql`CASE WHEN LENGTH(IFNULL(${email.text}, '')) > ${TEXT_PREVIEW_LEN} OR LENGTH(IFNULL(${email.content}, '')) > ${CONTENT_PREVIEW_LEN} THEN 1 ELSE 0 END`,
			})
			.from(email)
			.where(and(eq(email.threadId, threadId), gt(email.id, numericId)))
			.orderBy(asc(email.id))
			.limit(NEIGHBOUR_LIMIT + 1)
			.all();

		// Current row: pull the full row via `selectById` so the
		// `text` / `content` columns are available for the
		// preview-override below.
		const currentPromise = this.selectById(c, numericId);

		const totalPromise = orm(c.env).select({ total: count() }).from(email).where(eq(email.threadId, threadId)).get();

		const [olderAsc, newerAsc, currentRow, totalRow] = await Promise.all([olderPromise, newerPromise, currentPromise, totalPromise]);

		if (!currentRow) {
			throw new BizError(t('notExistEmailReply'));
		}

		const hasMoreOlder = olderAsc.length > NEIGHBOUR_LIMIT;
		const hasMoreNewer = newerAsc.length > NEIGHBOUR_LIMIT;
		const olderTrimmed = hasMoreOlder ? olderAsc.slice(0, NEIGHBOUR_LIMIT) : olderAsc;
		const newerTrimmed = hasMoreNewer ? newerAsc.slice(0, NEIGHBOUR_LIMIT) : newerAsc;

		// Reverse the older slice so the chain reads oldest→newest.
		const olderAscending = olderTrimmed.slice().reverse();

		const list = await this._hydrateChain(c, [...olderAscending, currentRow, ...newerTrimmed], [currentRow.id]);

		return {
			list,
			total: totalRow ? totalRow.total : list.length,
			hasMoreOlder,
			hasMoreNewer,
		};
	},

	// Hydrate a chain window (returned by `thread()`) with star and
	// attachment metadata in two batch round-trips, then overwrite
	// the preview fields on the currently-open row(s) with the full
	// `text` / `content` so the web client can treat every chain row
	// uniformly without splicing in the list row.
	async _hydrateChain(c, rows, currentIds) {
		const ids = rows.map((r) => r.id);
		const [starList, attsList] = ids.length
			? await Promise.all([starService.selectByEmailIds(c, ids), attService.selectByEmailIds(c, ids)])
			: [[], []];
		const starredIds = new Set(starList.map((s) => s.emailId));
		const attsByEmail = new Map();
		for (const a of attsList) {
			const arr = attsByEmail.get(a.emailId) ?? [];
			arr.push(a);
			attsByEmail.set(a.emailId, arr);
		}
		const currentIdSet = new Set(currentIds);
		return rows.map((row) => {
			const r2domain = row.type === 'receive' ? getR2Domain(row.toEmail) : getR2Domain(row.fromEmail);
			const attList = (attsByEmail.get(row.id) ?? []).map((a) => ({ ...a, url: `https://${r2domain}/${a.key}` }));
			if (currentIdSet.has(row.id)) {
				return {
					...row,
					textPreview: row.text ?? '',
					contentPreview: row.content ?? '',
					bodyTruncated: 0,
					isStar: starredIds.has(row.id) ? 1 : 0,
					attList,
				};
			}
			return {
				...row,
				isStar: starredIds.has(row.id) ? 1 : 0,
				attList,
			};
		});
	},

	// Hydrate a single email row with star + attachment metadata, matching
	// the shape `list()` returns. Pulled out of `list()` so `thread()` can
	// reuse it without duplicating the join logic.
	async hydrateRow(c, emailRow) {
		const [starList, attsList] = await Promise.all([
			starService.selectByEmailIds(c, [emailRow.id]),
			attService.selectByEmailIds(c, [emailRow.id]),
		]);
		const isStar = starList.some((s) => s.emailId === emailRow.id) ? 1 : 0;
		const r2domain = emailRow.type === 'receive' ? getR2Domain(emailRow.toEmail) : getR2Domain(emailRow.fromEmail);
		const attList = attsList.filter((a) => a.emailId === emailRow.id).map((a) => ({ ...a, url: `https://${r2domain}/${a.key}` }));
		return { ...emailRow, isStar, attList };
	},

	async getOne(c, params) {
		// On-demand full-body fetch for a single email. Used by
		// the ReadingPane to expand a prior message in a thread
		// after the lightweight `thread()` preview page already
		// shipped the chain. Returns the same row shape as
		// `list()` (full `text` / `content`) so the client can
		// swap it into the existing `EmailItem` slot without
		// any field-name remapping.
		//
		// IDOR safety: the worker is per-account and the
		// platform proxy only routes to a worker bound to the
		// user's domain (`resolveEmailWorkerForDomain` checks
		// the binding before issuing the request), so a
		// successfully dispatched request already proves
		// domain ownership. We still verify the row's
		// `from_domain` / `to_domain` matches the `domain`
		// hint in the URL so a stale binding (e.g. a domain
		// transferred to another account) can't leak rows
		// across workers.
		const { emailId, domain } = params;
		const numericId = Number(emailId);
		if (!numericId) {
			throw new BizError('emailId is required');
		}
		if (!domain) {
			throw new BizError('domain is required');
		}
		const row = await this.selectById(c, numericId);
		if (!row) {
			throw new BizError(t('notExistEmailReply'));
		}
		const matchesDomain = row.toDomain === domain || row.fromDomain === domain;
		if (!matchesDomain) {
			// Don't leak existence — the binding check should
			// have caught this already; if it didn't, treat
			// the row as not-found from this caller's
			// perspective.
			throw new BizError(t('notExistEmailReply'));
		}
		return this.hydrateRow(c, row);
	},

	async delete(c, params) {
		// Single-row real delete. Shares the same path as the
		// multi-select batch delete (`batchDelete`) so the
		// attachment cascade + unread-count decrement stay in
		// one place. The ReadingPane trash button and any future
		// single-row caller now do the right thing automatically.
		return this.batchDelete(c, params);
	},

	// Capture the recipient addresses of every email row that is
	// currently (unread, live) under the given `WHERE` fragment.
	// Returns a flat list with duplicates; the service-side
	// `batchedDecrement` de-dupes before binding. The Drizzle
	// `and(...)` helper composes this fragment with the
	// unread+live predicate so callers can pass an arbitrary
	// additional filter (e.g. `inArray(email.id, [...])`).
	// Capture the recipient addresses of every email row that is
	// currently unread under the given `WHERE` fragment. Returns a
	// flat list with duplicates; the service-side
	// `batchedDecrement` de-dupes before binding. The Drizzle
	// `and(...)` helper composes this fragment with the
	// unread predicate so callers can pass an arbitrary additional
	// filter (e.g. `inArray(email.id, [...])`).
	async _selectUnreadToEmails(c, whereFragment) {
		const rows = await orm(c.env)
			.select({ toEmail: email.toEmail })
			.from(email)
			.where(and(whereFragment, eq(email.unread, EmailConst.unread.UNREAD)))
			.all();
		return rows.map((row) => row.toEmail);
	},

	async save(env, params, cidAttList, r2domain) {
		params.content = this.imgReplace(params.content, cidAttList, r2domain);
		// 过滤 undefined 值，D1 不支持
		const filteredParams = {};
		for (const [key, value] of Object.entries(params)) {
			filteredParams[key] = value === undefined ? null : value;
		}
		// Materialise the conversation chain. We always store the
		// thread root's messageId, never the intermediate parent's,
		// so `thread()` can pull the whole chain with one indexed
		// `thread_id = ?` lookup. If the message has no Message-ID
		// (some senders strip the header) we treat it as an orphan
		// and leave `thread_id` null — the row stays in the mailbox
		// but won't be findable through any thread query, which is
		// the only correct behaviour given we have no chain anchor.
		const { threadId } = await this.resolveThreadId(env, params);
		filteredParams.threadId = threadId;
		const inserted = await orm(env).insert(email).values(filteredParams).returning().get();

		// New row is unread by default (`unread` column default = 1
		// in the migration), so bump the per-recipient counter that
		// `countUnreadByDomain*` reads. Best-effort: the read path
		// tolerates transient drift, and the receive flow already
		// has a separate "row didn't get inserted" failure mode.
		await unreadcountService.increment(env, inserted.toEmail);

		return inserted;
	},

	// Compute the conversation chain anchor for an inbound or
	// outbound email from its raw `inReplyTo` / `messageId` headers.
	// Walks the parent by `messageId` exactly once; if the parent is
	// unknown to this D1 (cross-worker reply, header was forged, etc.)
	// we fall back to "this is its own thread root" so the row still
	// has a thread anchor. Returns `null` for `threadId` only when
	// there's no `messageId` at all — those rows are unrecoverable
	// in any thread view, and pretending otherwise would orphan
	// unrelated emails by stamping them with a fake id.
	async resolveThreadId(env, params) {
		const { inReplyTo, messageId } = params;
		if (!messageId) {
			return { threadId: null };
		}
		if (inReplyTo) {
			const parent = await orm(env).select({ threadId: email.threadId }).from(email).where(eq(email.messageId, inReplyTo)).get();
			if (parent) {
				return { threadId: parent.threadId || inReplyTo };
			}
		}
		return { threadId: messageId };
	},

	// Outbound unified entry point — handles both brand-new sends and
	// replies through a single code path. The wire payload is
	// already-decided: the caller (platform action / AI agent) has
	// resolved the `from` address, picked the `to` list, and (for a
	// reply) computed the `threading` columns from the parent row.
	// The worker just validates, inserts, ships, and stamps
	// `messageId` / `threadId`. See `EmailSendRequest` in
	// `@flowmails/shared` for the wire contract.
	//
	// Reply vs. new-send is signalled purely by the presence of
	// `threading`: present → reply (SMTP In-Reply-To / References
	// headers set; row gets the parent's thread anchor); absent →
	// new send (worker stamps the SMTP-assigned `Message-ID` as the
	// new thread root after the send returns).
	async dispatchOutbound(c, params) {
		const { from, fromName, to, manyType, subject, text, content, attachments, threading } = params;

		// Sender validation. The platform's `resolveFromAddress`
		// already enforces localpart + domain + route-table rules;
		// the worker-side check is the safety net for the AI agent
		// path and any other non-platform caller.
		const fromValue = (from || '').trim().toLowerCase();
		if (!fromValue || !verifyUtils.isEmail(fromValue)) {
			throw new BizError(t('notEmail'));
		}

		// Recipient validation. Empty list or a non-email entry is
		// a caller bug — surface as a `BizError` so the platform
		// action shows a clear message instead of a FAILED row.
		if (!Array.isArray(to) || to.length === 0) {
			throw new BizError(t('emptyEmail'));
		}
		const recipients = to.map((s) => `${s || ''}`.trim()).filter(Boolean);
		if (recipients.length === 0) {
			throw new BizError(t('emptyEmail'));
		}
		for (const r of recipients) {
			if (!verifyUtils.isEmail(r)) {
				throw new BizError(t('notEmail'));
			}
		}

		// Subject + body validation. Both new sends and replies
		// require a non-empty subject and at least one of text /
		// content — the platform's `InlineReplyComposer` defaults
		// to `Re: <parentSubject>`, so a missing subject here is a
		// caller bug, not a feature.
		const subjectValue = (subject || '').trim();
		if (!subjectValue) {
			throw new BizError('subject is required');
		}
		if (!text?.trim() && !content?.trim()) {
			throw new BizError('text or content is required');
		}

		// `fromName` is optional. Fall back to the local-part of
		// the address (capitalised) so the column is never blank.
		const resolvedFromName = (fromName && fromName.trim()) || emailUtils.getName(fromValue) || null;

		// `manyType: "divide"` yields one envelope per recipient
		// (each can't see the others); default is a single envelope
		// with all recipients visible to each other.
		const sendOneByOne = manyType === 'divide';
		const groups = sendOneByOne ? recipients.map((r) => [r]) : [recipients];

		const results = [];
		for (const group of groups) {
			// Inline-image extraction. The platform's reply
			// composer no longer inlines a quote of the parent body,
			// so the legacy second-pass `imgReplace` (which rewrote
			// `cid:` references against the parent's R2 bucket) is
			// dropped — it was a no-op on the new flow. The first
			// pass still lifts base64 / `/oss/` images out of the
			// user's HTML into the platform's R2 bucket.
			let html = (content || '').trim();
			let imageDataList = [];
			if (html) {
				const transformed = await attService.toImageUrlHtml(c, html, getR2Domain(fromValue));
				imageDataList = transformed.imageDataList || [];
				html = transformed.html || html;
			}

			const toEmail = group[0];
			const toName = emailUtils.getName(toEmail) || null;
			const textValue = (text && text.trim()) || (html ? emailUtils.htmlToText(html) : null) || null;
			const recipientJson = sendOneByOne
				? JSON.stringify([
						{
							address: group[0],
							name: emailUtils.getName(group[0]) || '',
						},
					])
				: JSON.stringify(
						group.map((addr) => ({
							address: addr,
							name: emailUtils.getName(addr) || '',
						})),
					);

			const row = {
				fromEmail: fromValue,
				fromName: resolvedFromName,
				toEmail,
				toName,
				subject: subjectValue,
				content: html || null,
				text: textValue,
				type: 'send',
				// The sender has obviously "read" what they just
				// composed. Seed read at insert time so the Sent
				// tab and any inbox filter ignore `unread` for
				// `type = 'send'` rows correctly.
				unread: 0,
				status: EmailConst.status.SAVING,
				recipient: recipientJson,
				// Threading columns come from the caller verbatim
				// for a reply; for a new send they're null here and
				// the post-success update below stamps the new
				// thread anchor.
				inReplyTo: threading?.inReplyTo ?? null,
				references: threading?.references ?? null,
				threadId: threading?.threadId ?? null,
			};

			const inserted = await orm(c.env).insert(email).values(row).returning().get();

			if (imageDataList.length > 0) {
				await attService.saveArticleAtt(c, imageDataList, inserted.id);
			}
			if (attachments?.length > 0) {
				await attService.saveSendAtt(c, attachments, inserted.id);
			}

			const sendParams = {
				from: fromValue,
				fromName: resolvedFromName || undefined,
				to: sendOneByOne ? [group[0]] : group,
				subject: subjectValue,
				text: textValue,
				html: html || undefined,
				attachments: [...imageDataList, ...(attachments || [])],
			};
			// SMTP threading headers. The recipient's mail client
			// uses these to thread the new message with the
			// original conversation — `threading.threadId` is the
			// row-level anchor; the SMTP headers are the wire-level
			// hint that lives on the envelope.
			if (threading) {
				const referencesList = threading.references ? JSON.parse(threading.references) : [];
				sendParams.headers = {
					'in-reply-to': threading.inReplyTo,
					references: referencesList.join(' '),
				};
			}

			const sendResult = await cfEmailService.send(c.env, sendParams);
			const { data, error } = sendResult;

			if (error) {
				// Unified failure handling: write a FAILED row and
				// continue. The platform action inspects
				// `data[i].status === 8` (FAILED — see the
				// `EmailStatus` union in `@flowmails/shared`) and
				// surfaces the error to the user; no `BizError`
				// escapes to the route handler.
				const failedRow = await orm(c.env)
					.update(email)
					.set({
						status: EmailConst.status.FAILED,
						send_feedback: error.message,
					})
					.where(eq(email.id, inserted.id))
					.returning()
					.get();
				const failedAtts = await attService.selectByEmailIds(c, [inserted.id]);
				results.push(this.toEmailRowResult(failedRow, failedAtts));
				continue;
			}

			// A reply already wrote its thread anchor at insert
			// time; only `messageId` needs to be filled in here. A
			// fresh send is the root of its own thread — the
			// SMTP-assigned `messageId` becomes both `messageId`
			// and `threadId`.
			const setClause = threading
				? { status: EmailConst.status.SENT, messageId: data.id }
				: {
						status: EmailConst.status.SENT,
						messageId: data.id,
						threadId: data.id,
					};
			const updatedRow = await orm(c.env).update(email).set(setClause).where(eq(email.id, inserted.id)).returning().get();
			const attList = await attService.selectByEmailIds(c, [inserted.id]);
			results.push(this.toEmailRowResult(updatedRow, attList));
		}

		return results;
	},

	toEmailRowResult(row, attList) {
		return {
			emailId: row.id,
			sendEmail: row.fromEmail,
			name: row.fromName || '',
			subject: row.subject || '',
			text: row.text || '',
			content: row.content || '',
			type: row.type,
			status: row.status,
			recipient: row.recipient || '[]',
			resendEmailId: row.messageId || '',
			unread: row.unread,
			createTime: row.createTime,
			isStar: 0,
			attList,
		};
	},

	imgReplace(content, cidAttList, r2domain) {
		if (!content) {
			return '';
		}

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		const useAtts = [];

		for (const img of images) {
			const src = img.getAttribute('src');
			if (src && src.startsWith('cid:') && cidAttList) {
				const cid = src.replace(/^cid:/, '');
				const cidAttIndex = cidAttList.findIndex((cidAtt) => cidAtt.contentId && cidAtt.contentId.replace(/^<|>$/g, '') === cid);

				if (cidAttIndex > -1) {
					const cidAtt = cidAttList[cidAttIndex];
					img.setAttribute('src', `https://${r2domain}/${cidAtt.key}`);
					useAtts.push({ ...cidAtt, type: 'embed' });
				}
			}
		}

		return document.toString();
	},

	async selectById(c, emailId) {
		return await orm(c.env).select().from(email).where(eq(email.id, emailId)).get();
	},

	async selectByIds(c, emailIds) {
		return await orm(c.env).select().from(email).where(inArray(email.id, emailIds)).get();
	},

	async latest(c, params) {
		const { emailId, type, domain } = params;
		// type 默认值
		const typeValue = type === 'send' ? 'send' : 'receive';

		const conditions = [eq(email.type, typeValue)];

		if (emailId) {
			conditions.push(gt(email.id, emailId));
		}

		// Same domain-equality rewrite as `list()`. The `idx_email_inbox`
		// / `idx_email_sentbox` partial indexes both lead with the
		// matching domain column, so this is a single range scan with
		// `id > ?` slicing off the rows we've already seen.
		if (domain) {
			const domainColumn = typeValue === 'send' ? email.fromDomain : email.toDomain;
			conditions.push(eq(domainColumn, domain));
		}

		const list = await orm(c.env)
			.select()
			.from(email)
			.where(and(...conditions))
			.orderBy(desc(email.id))
			.limit(20);

		const emailIds = list.map((item) => item.id);

		if (emailIds.length > 0) {
			const attsList = await attService.selectByEmailIds(c, emailIds);

			list.forEach((emailRow) => {
				const atts = attsList.filter((attsRow) => attsRow.emailId === emailRow.id);
				emailRow.attList = atts;
			});
		}

		return list;
	},

	// 1.1.6 — `physicsDelete` was folded into `batchDelete`. The
	// two paths shared the same cascade (attachments + stars + row
	// drop) and the only difference was that `batchDelete` used
	// `is_del = 1`. Now that deletes are real, the single
	// `batchDelete` body covers both call sites.

	async updateEmailStatus(c, params) {
		const { status, messageId, send_feedback } = params;
		return await orm(c.env)
			.update(email)
			.set({
				status,
				send_feedback,
			})
			.where(eq(email.messageId, messageId))
			.returning()
			.get();
	},

	async completeReceive(env, status, emailId) {
		return await orm(env)
			.update(email)
			.set({
				status,
			})
			.where(eq(email.id, emailId))
			.returning()
			.get();
	},

	async completeReceiveAll(c) {
		// 直接将所有SAVING状态的邮件标记为RECEIVE
		await c.env.db.prepare(`UPDATE email SET status = ${EmailConst.status.RECEIVE} WHERE status = ${EmailConst.status.SAVING}`).run();
	},

	async batchDelete(c, params) {
		// Bulk real-delete by id. The web client now passes an
		// explicit list of ids from the emailbox multi-select, so
		// we can drop the earlier `like`-based search-and-delete
		// form (which took arbitrary substring filters and could
		// wipe an entire mailbox on a loose query) and turn this
		// into a single `inArray(...)` DELETE.
		//
		// Order matters: capture the (unread) `toEmail`s *before*
		// the row is dropped so the unread-count cache can
		// decrement the right mailboxes, cascade to attachments
		// + stars (so R2 objects don't leak), then run the
		// DELETE, then decrement the cache. The mutation-then-
		// decrement ordering means a dropped cache update leaves
		// the count high (recoverable) instead of low (a
		// user-visible undercount).
		const rawIds = params.emailIds;
		const emailIds = (Array.isArray(rawIds) ? rawIds : String(rawIds ?? '').split(','))
			.map((s) => Number(String(s).trim()))
			.filter((n) => Number.isFinite(n) && n > 0);
		if (emailIds.length === 0) {
			return;
		}

		const toEmails = await this._selectUnreadToEmails(c, inArray(email.id, emailIds));

		await attService.removeByEmailIds(c, emailIds);
		await starService.removeByEmailIds(c, emailIds);
		await orm(c.env).delete(email).where(inArray(email.id, emailIds)).run();
		await unreadcountService.batchedDecrement(c.env, toEmails);
	},

	async read(c, params) {
		const { emailIds } = params;
		// Capture first, mutate, then decrement. The mutation
		// UPDATE is unconditional on the unread column (it just
		// sets it to READ), so we need the pre-mutation snapshot
		// to know which counters to move. The `WHERE count > 0`
		// guard inside `batchedDecrement` makes a duplicate
		// decrement — e.g. from a concurrent reader that
		// selected the same row — a safe no-op.
		const toEmails = await this._selectUnreadToEmails(c, inArray(email.id, emailIds));
		await orm(c.env).update(email).set({ unread: EmailConst.unread.READ }).where(inArray(email.id, emailIds));
		await unreadcountService.batchedDecrement(c.env, toEmails);
	},

	async countUnreadByDomains(c, domains) {
		// Reads from the maintained `unreadcount` table — one
		// indexed range scan per chunk of up to 64 domains, instead
		// of the old N × `COUNT(*)` over the live `email` table.
		// Domains with no unreadcount rows are reported as 0 to
		// preserve the pre-rewrite contract.
		return unreadcountService.sumByDomains(c.env, domains);
	},

	async countUnreadByDomain(c, domain) {
		// Per-recipient unread map for a single domain — preserved
		// contract from the pre-rewrite implementation. The query
		// is a single indexed range scan on the
		// `(to_domain) WHERE count > 0` partial index.
		return unreadcountService.listByDomain(c.env, domain);
	},
};

export default emailService;
