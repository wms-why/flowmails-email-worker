import { desc, eq, inArray, lt, sql } from 'drizzle-orm';
import emailEntity from '../entity/email';
import orm from '../entity/orm';
import { star } from '../entity/star';
import BizError from '../utils/biz-error';
import { t } from '../i18n/i18n';
import attService from './att-service';
import emailService from './email-service';
import { selectStarsByEmailIds } from '../utils/query-utils';
const starService = {
	async add(c, params) {
		const { emailId } = params;
		const email = await emailService.selectById(c, emailId);
		if (!email) {
			throw new BizError(t('starNotExistEmail'));
		}
		const exist = await orm(c.env).select().from(star).where(eq(star.emailId, emailId)).get();

		if (exist) {
			return;
		}

		await orm(c.env).insert(star).values({ emailId }).run();
	},

	async cancel(c, params) {
		const { emailId } = params;
		await orm(c.env).delete(star).where(eq(star.emailId, emailId)).run();
	},

	async list(c, params) {
		let { emailId, size } = params;
		emailId = Number(emailId);
		size = Number(size);

		if (!emailId) {
			emailId = 9999999999;
		}

		const list = await orm(c.env)
			.select({
				isStar: sql`1`.as('isStar'),
				starId: star.starId,
				...emailEntity,
			})
			.from(star)
			.leftJoin(emailEntity, eq(emailEntity.id, star.emailId))
			// 1.1.6 — `is_del` is gone, so the live-row filter is
			// just "this email still exists". The LEFT JOIN + the
			// `from(star)` driver already excludes orphaned star
			// rows whose email was deleted (no email row to join
			// against), so the join itself is the liveness gate.
			.where(lt(star.emailId, emailId))
			.orderBy(desc(star.emailId))
			.limit(size)
			.all();

		const emailIds = list.map((item) => item.emailId);

		const attsList = await attService.selectByEmailIds(c, emailIds);

		list.forEach((emailRow) => {
			const atts = attsList.filter((attsRow) => attsRow.emailId === emailRow.emailId);
			emailRow.attList = atts;
		});

		return { list };
	},
	async removeByEmailIds(c, emailIds) {
		await orm(c.env).delete(star).where(inArray(star.emailId, emailIds)).run();
	},

	async selectByEmailIds(c, emailIds) {
		// Chunked internally for the same D1 bind-variable ceiling as
		// `attService.selectByEmailIds` — a full 100-row list page
		// would otherwise exceed it and 500.
		return selectStarsByEmailIds(c, star, emailIds);
	},
};

export default starService;
