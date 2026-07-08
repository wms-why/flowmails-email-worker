import { EmailConst } from '../entity/email';
const analysisDao = {
	async numberCount(c) {
		const { results } = await c.env.db
			.prepare(
				`
            SELECT
				COALESCE(e.receiveTotal, 0) AS receiveTotal,
				COALESCE(e.sendTotal, 0) AS sendTotal,
				0 AS delReceiveTotal,
				0 AS delSendTotal,
				COALESCE(e.receiveTotal, 0) AS normalReceiveTotal,
				COALESCE(e.sendTotal, 0) AS normalSendTotal,
				1 AS accountTotal,
				1 AS normalAccountTotal,
				0 AS delAccountTotal,
				1 AS userTotal,
				1 AS normalUserTotal,
				0 AS delUserTotal
            FROM
                (
                    -- 1.1.6 — is_del column dropped; every row in
                    -- the table is a live row. The del* counters
                    -- stay in the result shape for API
                    -- backwards-compat and always report 0.
                    SELECT
                        SUM(CASE WHEN type = 'receive' THEN 1 ELSE 0 END) AS receiveTotal,
                        SUM(CASE WHEN type = 'send' THEN 1 ELSE 0 END) AS sendTotal
                    FROM
                        email where status != ${EmailConst.status.SAVING}
                ) e
        `,
			)
			.all();
		return results[0];
	},

	async userDayCount(_c, _diffHours) {
		// 单用户模式下返回空数组
		return [];
	},

	async receiveDayCount(c, diffHours) {
		const { results } = await c.env.db
			.prepare(
				`
            SELECT
                DATE(create_time,'+${diffHours} hours') AS date,
                COUNT(*) AS total
            FROM
                email
            WHERE
 			 DATE(create_time,'+${diffHours} hours') BETWEEN DATE('now', '-15 days', '+${diffHours} hours') AND DATE('now','-1 day','+${diffHours} hours')
                AND type = 'receive'
            GROUP BY
                DATE(create_time,'+${diffHours} hours')
            ORDER BY
                date ASC
        `,
			)
			.all();
		return results;
	},

	async sendDayCount(c, diffHours) {
		const { results } = await c.env.db
			.prepare(
				`
            SELECT
                DATE(create_time,'+${diffHours} hours') AS date,
                COUNT(*) AS total
            FROM
                email
            WHERE
 			 DATE(create_time,'+${diffHours} hours') BETWEEN DATE('now', '-15 days', '+${diffHours} hours') AND DATE('now','-1 day','+${diffHours} hours')
                AND type = 'send'
            GROUP BY
                DATE(create_time,'+${diffHours} hours')
            ORDER BY
                date ASC
        `,
			)
			.all();
		return results;
	},
};

export default analysisDao;
