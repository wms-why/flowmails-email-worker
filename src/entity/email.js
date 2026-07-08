import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const EmailConst = {
	status: {
		RECEIVE: 0,
		SENT: 1,
		DELIVERED: 2,
		BOUNCED: 3,
		COMPLAINED: 4,
		DELAYED: 5,
		SAVING: 6,
		NOONE: 7,
		FAILED: 8,
	},
	unread: {
		UNREAD: 1,
		READ: 0,
	},
};

// Address-part split expressions shared by the entity file and the
// bootstrap migration — both must agree byte-for-byte. The expression
// is intentionally a no-op (returns the whole address as the local
// part, empty string as the domain part) when there's no `@`, so
// malformed addresses still produce well-defined columns.
const splitOnAt = (column) => sql`(CASE WHEN instr(${column}, '@') > 0 THEN substr(${column}, 1, instr(${column}, '@') - 1) ELSE ${column} END)`;
const domainOnAt = (column) => sql`(CASE WHEN instr(${column}, '@') > 0 THEN substr(${column}, instr(${column}, '@') + 1) ELSE '' END)`;

export const email = sqliteTable('email', {
	id: integer('id').primaryKey({ autoIncrement: true }),

	// Sender addressing
	fromEmail: text('from_email').notNull(),
	// Virtual columns: split the address once at write/read so the
	// domain-equality and localpart-`IN` filters in `list()` /
	// `latest()` / `countUnread*()` can hit a B-tree index. SQLite
	// B-tree indexes can't accelerate `LIKE '%@domain'`, so we
	// materialise the post-`@` part as its own indexed column.
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

	// Conversation threading. `message_id` / `in_reply_to` are the
	// raw upstream values from the email's headers; `thread_id` is
	// our own materialised chain identifier (the root email's
	// `messageId`) — the indexed column that `thread()` filters on,
	// so one indexed lookup replaces the old `messageId IN chain ∪
	// inReplyTo IN chain` two-arm scan.
	messageId: text('message_id').default(''),
	inReplyTo: text('in_reply_to').default(''),
	threadId: text('thread_id'),

	// Send feedback (only meaningful for type='send')
	sendFeedback: text('send_feedback'),

	// Routing / state
	type: text('type').default('receive').notNull(),
	status: integer('status').default(EmailConst.status.RECEIVE).notNull(),
	unread: integer('unread').default(EmailConst.unread.UNREAD).notNull(),
	createTime: text('create_time')
		.default(sql`CURRENT_TIMESTAMP`)
		.notNull(),
	// 1.1.6 — `is_del` was removed. Deletes are now a real
	// `DELETE FROM email` (with cascade to `attachments` / `star` /
	// `unreadcount`); see `email-service.batchDelete`.
});
export default email;
