import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const attach = sqliteTable('attachments', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	emailId: integer('email_id').notNull(),
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
