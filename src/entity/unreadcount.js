import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// `unreadcount` is a per-recipient mailbox counter maintained by the
// service layer. The previous design answered `countUnreadByDomain*` with
// an O(email_rows_in_domain) `COUNT(*)` over the live `email` table; for
// mailboxes with thousands of received messages that fan-out is a hot
// read on every dashboard render. Materialising the count and updating
// it on receive/read/delete turns the read into an O(mailboxes_with_
// unread) range scan on a tiny partial index.
//
// `to_email` is the natural unique key (a mailbox address), so the row
// also doubles as a deduped cache of "this mailbox currently has
// outstanding mail" — empty rows can be cleaned up by a background
// sweep but don't have to be.
//
// `to_domain` is a virtual column mirroring the same expression used
// in `entity/email.js`; the partial index below is keyed on it so the
// domain-equality read hits a B-tree, not a `LIKE '%@…'` suffix scan.
const domainOnAt = (column) => sql`(CASE WHEN instr(${column}, '@') > 0 THEN substr(${column}, instr(${column}, '@') + 1) ELSE '' END)`;

export const unreadcount = sqliteTable('unreadcount', {
	toEmail: text('to_email').primaryKey().notNull(),
	toDomain: text('to_domain').generatedAlwaysAs(domainOnAt(sql`to_email`), { mode: 'virtual' }),
	count: integer('count').default(0).notNull(),
	updateTime: text('update_time')
		.default(sql`CURRENT_TIMESTAMP`)
		.notNull(),
});

export default unreadcount;
