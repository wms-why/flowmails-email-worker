// Maintenance helpers for the `unreadcount` table.
//
// `countUnreadByDomain*` reads from this table instead of doing a
// `COUNT(*)` over the live `email` table, so every state transition
// that affects "is this row still unread" has to go through here:
//
//   * `save()` — increment on insert of an unread row. Outbound
//     `reply()` / `send()` rows are inserted with `unread = 0`
//     (the sender has obviously read what they just wrote) and
//     intentionally do NOT call `increment`: the cache is scoped
//     to inbound receives only (the dashboard only queries
//     `to_domain IN (user's own domains)`, and a self-send no
//     longer bumps the Inbox badge — that is by design).
//   * `read()` / `delete()` / `batchDelete()` —
//     decrement for every row that *was* unread+live before the
//     transition. (`delete` delegates to `batchDelete`; the legacy
//     `physicsDelete` was folded into `batchDelete` in 1.1.6.)
//
// The D1 prepares are intentionally written by hand (no Drizzle
// `onConflictDoUpdate`) because the decrement needs a `WHERE count > 0`
// guard: a duplicate decrement must be a no-op, not a negative
// balance. The race window between "read the email row" and "fire the
// decrement" is benign — the next best-effort reconcile will catch it,
// and the dashboard's per-domain badge is allowed to be off-by-one
// transiently.

const UPSERT_SQL = `
	INSERT INTO unreadcount (to_email, count, update_time)
	VALUES (?1, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(to_email) DO UPDATE SET
		count = count + 1,
		update_time = CURRENT_TIMESTAMP
`;

// Guarded decrement. A row that's already at zero (e.g. another
// concurrent reader beat us to it) just isn't touched — SQLite's
// `WHERE` predicate is evaluated against the row's pre-update state.
const DECREMENT_SQL = `
	UPDATE unreadcount
	SET count = count - 1,
	    update_time = CURRENT_TIMESTAMP
	WHERE to_email = ?1 AND count > 0
`;

const SELECT_DOMAIN_SQL = `
	SELECT to_email AS toEmail, count
	FROM unreadcount
	WHERE to_domain = ?1 AND count > 0
`;

const unreadcountService = {
	// Increment the unread count for a single recipient mailbox. Best
	// effort — the read path tolerates transient drift, so we don't
	// wrap the surrounding email insert in a transaction.
	async increment(env, toEmail) {
		if (!toEmail) return;
		await env.db.prepare(UPSERT_SQL).bind(toEmail).run();
	},

	// Decrement the unread count for a single recipient mailbox.
	// No-op if the row doesn't exist or is already at zero (e.g.
	// another caller beat us to it, or the row was never seeded).
	async decrement(env, toEmail) {
		if (!toEmail) return;
		await env.db.prepare(DECREMENT_SQL).bind(toEmail).run();
	},

	// Bulk decrement for a list of (toEmail) values — used by
	// `read()` / `delete()` / `batchDelete()` after the caller has
	// already selected which rows were unread+live. Wraps the per-row
	// prepares in `db.batch` so a single D1 round trip covers the
	// whole transition.
	async batchedDecrement(env, toEmails) {
		const unique = [...new Set(toEmails.filter(Boolean))];
		if (unique.length === 0) return;
		const stmts = unique.map((toEmail) => env.db.prepare(DECREMENT_SQL).bind(toEmail));
		await env.db.batch(stmts);
	},

	// Per-recipient unread map for a single domain — preserves the
	// pre-rewrite contract of `countUnreadByDomain`.
	async listByDomain(env, domain) {
		if (!domain) return {};
		const { results } = await env.db.prepare(SELECT_DOMAIN_SQL).bind(domain).all();
		const out = {};
		for (const row of results) {
			out[row.toEmail] = row.count;
		}
		return out;
	},

	// Per-domain total unread count for a list of domains —
	// preserves the contract of `countUnreadByDomains`. Domains with
	// no unreadcount rows are reported as 0 so callers can render a
	// complete map.
	async sumByDomains(env, domains) {
		if (!domains || domains.length === 0) return {};
		// D1's `IN` clause is positional, so the placeholder count
		// has to match the bound slice exactly. We chunk at 64
		// (`?1`..`?64`) — well under SQLite's default
		// `SQLITE_MAX_VARIABLE_NUMBER` of 32766 — to keep the
		// statement cache happy and stay safe for accounts with
		// many bound domains.
		const result = {};
		const CHUNK = 64;
		for (let i = 0; i < domains.length; i += CHUNK) {
			const slice = domains.slice(i, i + CHUNK);
			const placeholders = Array.from({ length: slice.length }, (_, k) => `?${k + 1}`).join(',');
			const sql = `SELECT to_domain AS toDomain, SUM(count) AS total FROM unreadcount WHERE to_domain IN (${placeholders}) AND count > 0 GROUP BY to_domain`;
			const { results } = await env.db.prepare(sql).bind(...slice).all();
			for (const row of results) {
				result[row.toDomain] = row.total;
			}
		}
		for (const domain of domains) {
			if (result[domain] === undefined) result[domain] = 0;
		}
		return result;
	},
};

export default unreadcountService;
