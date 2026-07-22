import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const attach = sqliteTable('attachments', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	/**
	 * Owning email row id on the live `email` table. NOT NULL
	 * at the SQL level for backward compatibility with every
	 * existing query path (`selectByEmailIds`, `removeByEmailIds`,
	 * `removeAttByField`); see migration 1.2.0 for the
	 * `junk_email_id` companion column that lets an attachment
	 * follow its email into the junk folder without a separate
	 * `junk_attachments` table.
	 */
	emailId: integer('email_id').notNull(),
	/**
	 * Owning junk row id on `junk_email`. Set by `markAsJunk`
	 * when the parent email is moved out of the live table;
	 * cleared by `restoreFromJunk` when the junk row is moved
	 * back (with `email_id` rewritten to the new live row).
	 * Null when the attachment belongs to a live email.
	 */
	junkEmailId: integer('junk_email_id'),
	key: text('key').notNull(),
	filename: text('filename'),
	mimeType: text('mime_type'),
	size: integer('size'),
	status: text('status').default(0).notNull(),
	type: text('type').default('att').notNull(),
	disposition: text('disposition'),
	related: text('related'),
	contentId: text('content_id'),
	encoding: text('encoding'),
	createTime: text('create_time')
		.default(sql`CURRENT_TIMESTAMP`)
		.notNull(),
});
