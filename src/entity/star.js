import { sql } from 'drizzle-orm';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const star = sqliteTable('star', {
	starId: integer('star_id').primaryKey({ autoIncrement: true }),
	emailId: integer('email_id').notNull(),
	createTime: text('create_time')
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`),
});
