import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import unreadcountService from '../src/service/unreadcount-service';

/**
 * `unreadcount` cache maintenance — the per-mailbox counter the
 * dashboard's domain badge reads.
 *
 * The invariant these tests exist for: the counter must move by the
 * number of rows that actually flipped in each mailbox, not by the
 * number of distinct mailboxes touched. The pre-1.4.2 implementation
 * de-duped the snapshot with a `Set` and issued one `count - 1` per
 * unique mailbox, so "Mark all as read" on a mailbox with 5 unread
 * messages left the badge on 4 — and nothing could ever move it, since
 * the second click has no unread rows left to flip.
 *
 * Runs against miniflare's D1 via `@cloudflare/vitest-pool-workers`;
 * the schema comes from the worker's own `/bootstrap` endpoint so the
 * specs run against the same tables production does.
 */

const AUTH = { authorization: `Bearer ${env.JWT_SECRET}` };
const DOMAIN = 'unread-count.test';

const SUPPORT = `support@${DOMAIN}`;
const SALES = `sales@${DOMAIN}`;
const OTHER = `support@other.test`;

async function call(path, init = {}) {
	return SELF.fetch(`http://example.com/api${path}`, {
		...init,
		headers: { ...AUTH, ...(init.headers || {}) },
	});
}

/** Seed `n` inbound unread rows for one mailbox. Returns their ids. */
async function seedUnread(toEmail, n) {
	const at = toEmail.lastIndexOf('@');
	const ids = [];
	for (let i = 0; i < n; i += 1) {
		const { meta } = await env.db
			.prepare(
				`INSERT INTO email (from_email, to_email, subject, text, type, status, unread)
				 VALUES (?1, ?2, ?3, 'body', 'receive', 1, 1)`,
			)
			.bind(`sender${i}@example.test`, toEmail, `s${i}`)
			.run();
		ids.push(Number(meta.last_row_id));
	}
	return ids;
}

/** Seed `n` inbound *read* rows for one mailbox. */
async function seedRead(toEmail, n) {
	const ids = [];
	for (let i = 0; i < n; i += 1) {
		const { meta } = await env.db
			.prepare(
				`INSERT INTO email (from_email, to_email, subject, text, type, status, unread)
				 VALUES (?1, ?2, ?3, 'body', 'receive', 1, 0)`,
			)
			.bind(`sender${i}@example.test`, toEmail, `r${i}`)
			.run();
		ids.push(Number(meta.last_row_id));
	}
	return ids;
}

async function counter(toEmail) {
	const row = await env.db
		.prepare(`SELECT count FROM unreadcount WHERE to_email = ?1`)
		.bind(toEmail)
		.first();
	return row ? Number(row.count) : null;
}

async function unreadRows(toEmail) {
	const at = toEmail.lastIndexOf('@');
	const { results } = await env.db
		.prepare(`SELECT id FROM email WHERE to_domain = ?1 AND to_local = ?2 AND unread = 1`)
		.bind(toEmail.slice(at + 1), toEmail.slice(0, at))
		.all();
	return results.length;
}

async function readAll(domain = DOMAIN) {
	const res = await call('/email/readAll', {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ domain }),
	});
	expect(res.status).toBe(200);
	const body = await res.json();
	return body.data;
}

beforeAll(async () => {
	const res = await call('/bootstrap');
	expect(res.status).toBe(200);
});

beforeEach(async () => {
	await env.db
		.prepare(`DELETE FROM email WHERE to_domain IN (?, ?)`)
		.bind(DOMAIN, 'other.test')
		.run();
	await env.db
		.prepare(`DELETE FROM unreadcount WHERE to_domain IN (?, ?)`)
		.bind(DOMAIN, 'other.test')
		.run();
});

describe('batchedDecrement / batchedIncrement — per-mailbox deltas', () => {
	it('subtracts the number of flipped rows, not one per mailbox', async () => {
		await seedUnread(SUPPORT, 3);
		await unreadcountService.increment(env, SUPPORT);
		await unreadcountService.increment(env, SUPPORT);
		await unreadcountService.increment(env, SUPPORT);
		expect(await counter(SUPPORT)).toBe(3);

		// The snapshot `read()` takes: one entry per unread row.
		await unreadcountService.batchedDecrement(env, [SUPPORT, SUPPORT, SUPPORT]);
		expect(await counter(SUPPORT)).toBe(0);
	});

	it('splits the delta across mailboxes and ignores empty entries', async () => {
		await seedUnread(SUPPORT, 2);
		await seedUnread(SALES, 1);
		await unreadcountService.increment(env, SUPPORT);
		await unreadcountService.increment(env, SUPPORT);
		await unreadcountService.increment(env, SALES);

		await unreadcountService.batchedDecrement(env, [
			SUPPORT,
			SUPPORT,
			SALES,
			'',
			null,
			undefined,
		]);
		expect(await counter(SUPPORT)).toBe(0);
		expect(await counter(SALES)).toBe(0);
	});

	it('adds the number of flipped rows on the mark-unread mirror path', async () => {
		await seedRead(SUPPORT, 3);
		await unreadcountService.batchedIncrement(env, [SUPPORT, SUPPORT, SUPPORT]);
		expect(await counter(SUPPORT)).toBe(3);
	});

	it('never goes negative when the delta overshoots the counter', async () => {
		await seedUnread(SUPPORT, 1);
		await unreadcountService.increment(env, SUPPORT);
		expect(await counter(SUPPORT)).toBe(1);

		await unreadcountService.batchedDecrement(env, [SUPPORT, SUPPORT, SUPPORT]);
		expect(await counter(SUPPORT)).toBe(0);
	});

	it('is a no-op on a mailbox with no counter row and on an empty list', async () => {
		await seedUnread(SUPPORT, 2);
		await unreadcountService.batchedDecrement(env, []);
		expect(await counter(SUPPORT)).toBe(null);

		await unreadcountService.batchedDecrement(env, [SUPPORT, SUPPORT]);
		expect(await counter(SUPPORT)).toBe(null);
	});
});

describe('PUT /email/readAll — "Mark all as read"', () => {
	it('reports the row count and leaves every touched mailbox at 0', async () => {
		await seedUnread(SUPPORT, 5);
		await seedUnread(SALES, 2);
		await unreadcountService.batchedIncrement(env, [
			...Array(5).fill(SUPPORT),
			...Array(2).fill(SALES),
		]);

		expect(await readAll()).toEqual({ updated: 7 });
		expect(await counter(SUPPORT)).toBe(0);
		expect(await counter(SALES)).toBe(0);
		expect(await unreadRows(SUPPORT)).toBe(0);
		expect(await unreadRows(SALES)).toBe(0);
	});

	it('heals a counter that was already wrong before the click', async () => {
		// The exact shape the 1.4.1 bug left behind: two unread rows
		// flipped to read, one `count - 1` applied, badge stuck on 1
		// with nothing unread left to move it.
		const ids = await seedUnread(SUPPORT, 2);
		await unreadcountService.increment(env, SUPPORT);
		await unreadcountService.increment(env, SUPPORT);
		await env.db
			.prepare(`UPDATE email SET unread = 0 WHERE id = ?1 OR id = ?2`)
			.bind(ids[0], ids[1])
			.run();
		await unreadcountService.batchedDecrement(env, [SUPPORT]);
		expect(await unreadRows(SUPPORT)).toBe(0);
		expect(await counter(SUPPORT)).toBe(1);

		// A second click has nothing left to flip — `updated` is 0 —
		// and must still bring the badge to 0.
		expect(await readAll()).toEqual({ updated: 0 });
		expect(await counter(SUPPORT)).toBe(0);
	});

	it('heals a stuck counter under a localpart filter too', async () => {
		const ids = await seedUnread(SUPPORT, 1);
		await unreadcountService.increment(env, SUPPORT);
		await env.db.prepare(`UPDATE email SET unread = 0 WHERE id = ?1`).bind(ids[0]).run();
		expect(await counter(SUPPORT)).toBe(1);

		const res = await call('/email/readAll', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ domain: DOMAIN, to: [SUPPORT] }),
		});
		expect((await res.json()).data).toEqual({ updated: 0 });
		expect(await counter(SUPPORT)).toBe(0);
	});

	it('counts only the requested localparts and leaves the rest alone', async () => {
		await seedUnread(SUPPORT, 3);
		await seedUnread(SALES, 4);
		await unreadcountService.batchedIncrement(env, [
			...Array(3).fill(SUPPORT),
			...Array(4).fill(SALES),
		]);

		const res = await call('/email/readAll', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			// The proxy composes full addresses; the service strips
			// the domain back off before matching `to_local`.
			body: JSON.stringify({ domain: DOMAIN, to: [SUPPORT] }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual({ updated: 3 });
		expect(await counter(SUPPORT)).toBe(0);
		expect(await counter(SALES)).toBe(4);
		expect(await unreadRows(SALES)).toBe(4);
	});

	it('never crosses a domain boundary', async () => {
		await seedUnread(SUPPORT, 2);
		await seedUnread(OTHER, 2);
		await unreadcountService.batchedIncrement(env, [SUPPORT, SUPPORT, OTHER, OTHER]);

		expect(await readAll()).toEqual({ updated: 2 });
		expect(await counter(SUPPORT)).toBe(0);
		expect(await counter(OTHER)).toBe(2);
		expect(await unreadRows(OTHER)).toBe(2);
	});

	it('leaves outbound mail alone (the cache is inbound-receive scoped)', async () => {
		const { meta } = await env.db
			.prepare(
				`INSERT INTO email (from_email, to_email, subject, text, type, status, unread)
				 VALUES (?1, ?2, 'sent', 'body', 'send', 1, 0)`,
			)
			.bind(SUPPORT, `someone@example.test`)
			.run();
		expect(Number(meta.last_row_id)).toBeGreaterThan(0);

		await seedUnread(SUPPORT, 2);
		await unreadcountService.batchedIncrement(env, [SUPPORT, SUPPORT]);

		expect(await readAll()).toEqual({ updated: 2 });
		expect(await counter(SUPPORT)).toBe(0);
	});

	it('refuses a domain-less call instead of widening to every mailbox', async () => {
		// `to_domain` is the IDOR boundary: without it the scope would
		// be every inbound row in this D1. The proxy always sends the
		// resolved domain name, so a missing one is a contract break,
		// not a user-facing case.
		await seedUnread(SUPPORT, 2);
		await unreadcountService.increment(env, SUPPORT);
		await unreadcountService.increment(env, SUPPORT);

		const res = await call('/email/readAll', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({}),
		});
		// This worker reports failures in the envelope, not the HTTP
		// status: `onError` renders `result.fail(message, code)` and
		// the platform proxy keys off `json.code`. So assert the
		// envelope failed — and, above all, that nothing was touched.
		const body = await res.json();
		expect(body.code).not.toBe(200);
		expect(String(body.message)).toContain('domain is required');
		expect(await unreadRows(SUPPORT)).toBe(2);
		expect(await counter(SUPPORT)).toBe(2);
	});

	it('feeds POST /email/countUnread — the number the badge actually renders', async () => {
		await seedUnread(SUPPORT, 4);
		await seedUnread(SALES, 1);
		await unreadcountService.batchedIncrement(env, [
			...Array(4).fill(SUPPORT),
			SALES,
		]);

		const before = await call('/email/countUnread', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ domains: [DOMAIN] }),
		});
		expect((await before.json()).data).toEqual({ [DOMAIN]: 5 });

		await readAll();

		const after = await call('/email/countUnread', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ domains: [DOMAIN] }),
		});
		expect((await after.json()).data).toEqual({ [DOMAIN]: 0 });
	});
});