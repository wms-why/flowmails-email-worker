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
//   * `readAll()` — the emailbox "Mark all as read" bulk transition.
//     It doesn't decrement at all, it **zeroes** the counters of the
//     mailboxes in scope: see `zeroCounts` below.
//
// The D1 prepares are intentionally written by hand (no Drizzle
// `onConflictDoUpdate`) because the decrement needs a `WHERE count > 0`
// guard: a duplicate decrement must be a no-op, not a negative
// balance. The race window between "read the email row" and "fire the
// decrement" is benign — the next best-effort reconcile will catch it,
// and the dashboard's per-domain badge is allowed to be off-by-one
// transiently.
//
// Every bulk *delta* helper takes a **flat list with duplicates** (one
// entry per affected row) and tallies it into a per-mailbox delta
// before binding. The previous implementation de-duped the list with a
// `Set` and issued exactly one `count - 1` per unique mailbox, so a
// transition that flipped N unread rows in the SAME mailbox (a bulk
// mark-as-read, a batch delete) only moved the counter by 1 and left
// the badge permanently over-counted.

const UPSERT_SQL = `
	INSERT INTO unreadcount (to_email, count, update_time)
	VALUES (?1, 1, CURRENT_TIMESTAMP)
	ON CONFLICT(to_email) DO UPDATE SET
		count = count + 1,
		update_time = CURRENT_TIMESTAMP
`;

// Delta increment — same upsert as `UPSERT_SQL` but adds the number
// of rows that actually flipped back to unread (bulk `markUnread`)
// instead of a flat 1.
const INCREMENT_BY_SQL = `
	INSERT INTO unreadcount (to_email, count, update_time)
	VALUES (?1, ?2, CURRENT_TIMESTAMP)
	ON CONFLICT(to_email) DO UPDATE SET
		count = count + ?2,
		update_time = CURRENT_TIMESTAMP
`;

// Guarded decrement.
const DECREMENT_SQL = `
	UPDATE unreadcount
	SET count = count - 1,
	    update_time = CURRENT_TIMESTAMP
	WHERE to_email = ?1 AND count > 0
`;

// Delta decrement. `MAX(..., 0)` clamps an over-large delta (e.g. the
// cache already drifted low) to zero instead of going negative; the
// `count > 0` guard keeps a repeated call on an emptied mailbox a
// no-op.
const DECREMENT_BY_SQL = `
	UPDATE unreadcount
	SET count = MAX(count - ?2, 0),
	    update_time = CURRENT_TIMESTAMP
	WHERE to_email = ?1 AND count > 0
`;

// Zero the counter for one mailbox.
//
// Used by the bulk "Mark all as read" transition, whose scope is
// "every unread inbound row of these mailboxes" — so the correct
// post-condition is simply zero, and writing zero is both cheaper
// than a recount and stronger at healing: a counter an older worker
// left wrong (the pre-1.4.2 `count - 1`-per-mailbox bug) lands on
// the right number, which no decrement could ever do.
//
// No `WHERE count > 0` guard here (unlike the decrements): this is
// an absolute write, not a relative one, so a repeat is a harmless
// no-op either way.
const ZERO_SQL = `
	UPDATE unreadcount
	SET count = 0,
	    update_time = CURRENT_TIMESTAMP
	WHERE to_email = ?1
`;

const SELECT_DOMAIN_SQL = `
	SELECT to_email AS toEmail, count
	FROM unreadcount
	WHERE to_domain = ?1 AND count > 0
`;

// Collapse a flat list of recipient addresses (one entry per affected
// row, so the same mailbox repeats) into a `Map<toEmail, delta>`.
// This is the whole point of the bulk helpers: the counter moves by
// how many rows actually flipped in each mailbox, not by how many
// distinct mailboxes were touched.
function tally(toEmails) {
	const deltas = new Map();
	for (const toEmail of toEmails ?? []) {
		const key = String(toEmail ?? '').trim();
		if (!key) continue;
		deltas.set(key, (deltas.get(key) ?? 0) + 1);
	}
	return deltas;
}

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
	// already selected which rows were unread+live. Wraps the
	// per-mailbox prepares in `db.batch` so a single D1 round trip
	// covers the whole transition.
	//
	// The input list keeps duplicates on purpose — it is a
	// per-affected-row snapshot. It gets tallied into per-mailbox
	// deltas here, so marking three unread messages in one mailbox
	// read subtracts 3. De-duping the list and subtracting a flat 1
	// per mailbox is what left the badge permanently over-counted
	// after every bulk transition.
	async batchedDecrement(env, toEmails) {
		const deltas = tally(toEmails);
		if (deltas.size === 0) return;
		const stmts = Array.from(deltas, ([toEmail, delta]) =>
			env.db.prepare(DECREMENT_BY_SQL).bind(toEmail, delta),
		);
		await env.db.batch(stmts);
	},

	// Bulk increment — the mirror image, used by `markUnread()` after
	// the caller has already selected which rows were read+live. Same
	// upsert shape as `UPSERT_SQL` but with the per-mailbox delta, so
	// bulk-marking three read messages unread in one mailbox adds 3.
	// `markUnread` snapshots FIRST (only rows whose flag genuinely
	// flipped), which keeps the delta accurate.
	async batchedIncrement(env, toEmails) {
		const deltas = tally(toEmails);
		if (deltas.size === 0) return;
		const stmts = Array.from(deltas, ([toEmail, delta]) =>
			env.db.prepare(INCREMENT_BY_SQL).bind(toEmail, delta),
		);
		await env.db.batch(stmts);
	},

	// Set the counter to **zero** for every mailbox in the list.
	//
	// The bulk "Mark all as read" transition uses this instead of
	// `batchedDecrement`, because its scope is "every unread inbound
	// row of these mailboxes": once the rows are flipped there is
	// provably nothing unread left in them, so zero *is* the truth.
	// Writing it outright — rather than subtracting the snapshot size —
	// is what repairs counters an older worker left wrong (the
	// pre-1.4.2 "one `count - 1` per mailbox" bug, which stranded
	// every bulk transition over-counted); a decrement can only ever
	// subtract from a wrong number, never correct it.
	//
	// The caller is responsible for the list: it must be the mailboxes
	// in *scope*, not just the ones the UPDATE flipped (see
	// `email-service.readAll`), otherwise a click that finds nothing
	// left to flip would heal nothing.
	//
	// Trade-off, for the record: this is an absolute write, so a
	// receive landing between the `email` UPDATE and this statement
	// loses its increment and the badge reads one low until the next
	// bulk read. Narrow window, and the next receive/mark-repair path
	// moves it again — accepted in exchange for the self-healing.
	//
	// Mailboxes with no `unreadcount` row are skipped (the UPDATE
	// matches nothing) — they were never tracked, which is a separate
	// pre-existing gap on the receive path.
	async zeroCounts(env, toEmails) {
		const unique = new Set(
			(toEmails ?? []).map((s) => String(s ?? '').trim()).filter(Boolean),
		);
		if (unique.size === 0) return;
		const stmts = Array.from(unique, (toEmail) =>
			env.db.prepare(ZERO_SQL).bind(toEmail),
		);
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
