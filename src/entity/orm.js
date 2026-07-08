import { drizzle } from 'drizzle-orm/d1';

export default function orm(env) {
	return drizzle(env.db, { logger: !!env.orm_log });
}
