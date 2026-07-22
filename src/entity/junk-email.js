import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// Address-part split expressions shared with `entity/email.js`.
// Both must agree byte-for-byte with the SQL in
// `service/bootstrap-service.js` (migration 1.2.0) so the
// virtual columns line up with the indexes the query path uses.
const splitOnAt = (column) => sql`(CASE WHEN instr(${column}, '@') > 0 THEN substr(${column}, 1, instr(${column}, '@') - 1) ELSE ${column} END)`;
const domainOnAt = (column) => sql`(CASE WHEN instr(${column}, '@') > 0 THEN substr(${column}, instr(${column}, '@') + 1) ELSE '' END)`;

/**
 * The `junk_email` table — a parallel sink for inbound messages
 * the Rspamd check classified as spam or phishing (action =
 * "reject"). Rows live here until either:
 *   - the user deletes them via the Junk tab, or
 *   - the user marks them "Not junk" → `emailService.restoreFromJunk`
 *     copies the row back into `email` with the spam fields stripped.
 *
 * Schema choices:
 *   - Same `from_*` / `to_*` virtual columns as `email`, so the
 *     list / count queries can hit the indexed equality on
 *     `to_domain` (junk rows are always inbound — the recipient's
 *     domain is what we filter on, same as the live inbox).
 *   - No `thread_id`. Junk mail is rarely part of a conversation
 *     and the restore path re-derives thread membership from
 *     `message_id` / `in_reply_to` against the live `email` table.
 *   - No `send_feedback` — outbound-only column.
 *   - `attList` is intentionally empty: V1 doesn't carry
 *     attachments into the junk table (see the file-level note in
 *     `packages/emailworker-types/src/email.ts`).
 *   - Rspamd scoring fields (`spam_*`) are stamped at the moment
 *     the row is moved out of `email`, so a stale "score" can
 *     never be confused with a fresh one.
 */
export const junkEmail = sqliteTable('junk_email', {
	id: integer('id').primaryKey({ autoIncrement: true }),

	// Sender addressing
	fromEmail: text('from_email').notNull(),
	fromLocal: text('from_local').generatedAlwaysAs(splitOnAt(sql`from_email`), { mode: 'virtual' }),
	fromDomain: text('from_domain').generatedAlwaysAs(domainOnAt(sql`from_email`), { mode: 'virtual' }),
	fromName: text('from_name'),

	// Recipient addressing
	toEmail: text('to_email').default('').notNull(),
	toLocal: text('to_local').generatedAlwaysAs(splitOnAt(sql`to_email`), { mode: 'virtual' }),
	toDomain: text('to_domain').generatedAlwaysAs(domainOnAt(sql`to_email`), { mode: 'virtual' }),
	toName: text('to_name'),

	// Content
	subject: text('subject'),
	text: text('text'),
	content: text('content'),

	// Multi-recipient metadata (preserved for fidelity; queries go
	// through `to_email` / `to_domain`).
	cc: text('cc').default('[]'),
	bcc: text('bcc').default('[]'),
	recipient: text('recipient'),

	// Upstream threading headers. Kept so a restored row can
	// re-attach to its parent chain on the live table.
	messageId: text('message_id').default(''),
	inReplyTo: text('in_reply_to').default(''),

	// Routing / state — junk rows are always inbound, but we keep
	// `type` for symmetry with `email` in case we ever split a
	// forwarded-junk path through it.
	type: text('type').default('receive').notNull(),
	status: integer('status').default(0).notNull(),
	unread: integer('unread').default(1).notNull(),
	createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),

	// Rspamd scoring metadata. Always present; populated by
	// `emailService.markAsJunk` at the moment the row is moved
	// out of the live `email` table.
	spamScore: real('spam_score').notNull(),
	spamAction: text('spam_action').notNull(),
	spamRequiredScore: real('spam_required_score').notNull(),
	/** JSON-encoded `Record<symbol, { score, description }>`. */
	spamSymbols: text('spam_symbols'),
	/** Unix epoch (ms) of when the score was recorded. */
	spamCheckedAt: integer('spam_checked_at').notNull(),
});

export default junkEmail;
