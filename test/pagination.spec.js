import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

/**
 * Mailbox paging bounds + the server-side Starred filter (1.5.0).
 *
 * Two invariants live here.
 *
 * 1. **An absent `size` means "the default page", never "no limit".**
 *    The pre-1.5.0 guard was `if (size > 30) size = 30` — an upper
 *    bound with no lower one. A caller that omitted `size` left it as
 *    `Number(undefined)` = `NaN`; `NaN > 30` is false, so `NaN`
 *    reached Drizzle's `buildLimit`, whose guard is
 *    `typeof limit === 'number' && limit >= 0` — also false for
 *    `NaN`. The LIMIT clause was dropped from the SQL entirely and
 *    the query returned the whole mailbox, so every emailbox page
 *    load was unbounded. These specs seed 120 rows and pin that a
 *    bare `/email/list` comes back with exactly one page.
 *
 * 2. **Starred is a server-side predicate.** It used to be a
 *    browser-side `isStar` filter over the fully-loaded inbox. It now
 *    rides the same `conditions` array as every other filter, so the
 *    `total` the pager divides by is the *starred* count — a separate
 *    assertion, because a starred filter that narrowed the rows but
 *    not the total would produce a pager that runs off the end.
 *
 * Runs against miniflare's D1 via `@cloudflare/vitest-pool-workers`;
 * the schema comes from the worker's own `/bootstrap` endpoint so the
 * specs run against the same tables production does.
 */

const AUTH = { authorization: `Bearer ${env.JWT_SECRET}` };
const DOMAIN = 'paging.test';
const INBOX = `support@${DOMAIN}`;

/** The worker's paging bounds, mirrored from `email-service.js`. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

async function call(path, init = {}) {
	return SELF.fetch(`http://example.com/api${path}`, {
		...init,
		headers: { ...AUTH, ...(init.headers || {}) },
	});
}

/**
 * Seed `n` inbound rows for one mailbox, oldest first, and return
 * their ids in that order. `to` defaults to the shared INBOX.
 */
async function seed(n, to = INBOX, type = 'receive') {
	const ids = [];
	for (let i = 0; i < n; i += 1) {
		const from = type === 'send' ? to : `sender${i}@example.test`;
		const toAddr = type === 'send' ? `peer${i}@${DOMAIN}` : to;
		const { meta } = await env.db
			.prepare(
				`INSERT INTO email (from_email, to_email, subject, text, type, status, unread)
				 VALUES (?1, ?2, ?3, 'body', ?4, 1, 0)`,
			)
			.bind(from, toAddr, `s${i}`, type)
			.run();
		ids.push(Number(meta.last_row_id));
	}
	return ids;
}

/** Star every id at `stride` intervals from the start of `ids`. */
async function starSome(ids, stride) {
	for (let i = 0; i < ids.length; i += stride) {
		await env.db
			.prepare(`INSERT OR IGNORE INTO star (email_id) VALUES (?1)`)
			.bind(ids[i])
			.run();
	}
}

/** Ids of every row currently addressed to one mailbox. */
async function idsFor(to) {
	const { results } = await env.db
		.prepare(`SELECT id FROM email WHERE to_email = ?1 ORDER BY id`)
		.bind(to)
		.all();
	return results.map((r) => Number(r.id));
}

/**
 * GET /email/list and return the decoded `data` payload.
 *
 * `size` / `emailId` / `to` / `starred` are passed through as-is and
 * `size` is deliberately omitted when undefined, so the "absent size"
 * specs exercise the real omitted-param path rather than `size=` .
 */
async function list({ type = 'receive', size, emailId, to, starred } = {}) {
	const params = new URLSearchParams({ type, domain: DOMAIN });
	if (size !== undefined) params.set('size', String(size));
	if (emailId !== undefined) params.set('emailId', String(emailId));
	if (to !== undefined) params.append('to', `${to}@${DOMAIN}`);
	if (starred !== undefined) params.set('starred', String(starred));

	const res = await call(`/email/list?${params.toString()}`);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.code).toBe(200);
	return body.data;
}

async function listJunk({ size } = {}) {
	const params = new URLSearchParams({ domain: DOMAIN });
	if (size !== undefined) params.set('size', String(size));

	const res = await call(`/email/junkList?${params.toString()}`);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.code).toBe(200);
	return body.data;
}

async function seedJunk(n) {
	for (let i = 0; i < n; i += 1) {
		await env.db
			.prepare(
				`INSERT INTO junk_email
				 (from_email, to_email, subject, text, type, status, unread,
				  spam_score, spam_action, spam_required_score, spam_checked_at)
				 VALUES (?1, ?2, ?3, 'body', 'receive', 1, 0, 7.5, 'reject', 5, 1)`,
			)
			.bind(`spammer${i}@example.test`, INBOX, `j${i}`)
			.run();
	}
}

beforeAll(async () => {
	const res = await call('/bootstrap');
	expect(res.status).toBe(200);
});

beforeEach(async () => {
	await env.db.prepare(`DELETE FROM star`).run();
	await env.db.prepare(`DELETE FROM junk_email`).run();
	await env.db.prepare(`DELETE FROM email`).run();
});

describe('page size bounds', () => {
	it('falls back to the default page when `size` is absent', async () => {
		// The regression: 120 rows exist, and a bare list request used
		// to come back with all 120 because the LIMIT clause was never
		// emitted. It must come back with exactly one page.
		await seed(120);
		const data = await list();
		expect(data.list).toHaveLength(DEFAULT_PAGE_SIZE);
		expect(data.total).toBe(120);
	});

	it('honours an explicit `size`', async () => {
		await seed(120);
		const data = await list({ size: 100 });
		expect(data.list).toHaveLength(MAX_PAGE_SIZE);
		expect(data.total).toBe(120);
	});

	it('clamps `size` above the max instead of honouring it', async () => {
		await seed(120);
		expect((await list({ size: 5000 })).list).toHaveLength(MAX_PAGE_SIZE);
	});

	it('treats a zero / negative / non-numeric `size` as "use the default"', async () => {
		await seed(120);
		for (const size of [0, -10, Number.NaN]) {
			const data = await list({ size });
			expect(data.list).toHaveLength(DEFAULT_PAGE_SIZE);
		}
	});

	it('returns a short final page rather than padding it', async () => {
		await seed(53);
		const first = await list({ size: 50 });
		expect(first.list).toHaveLength(50);

		const cursor = Math.min(...first.list.map((r) => r.id));
		const tail = await list({ size: 50, emailId: cursor });
		expect(tail.list).toHaveLength(3);
	});

	it('returns everything when the mailbox is smaller than one page', async () => {
		await seed(7);
		const data = await list();
		expect(data.list).toHaveLength(7);
		expect(data.total).toBe(7);
	});
});

describe('cursor paging', () => {
	it('walks the mailbox in `id DESC` order with no overlap and no gaps', async () => {
		await seed(120);

		const seen = [];
		let cursor;
		for (let page = 0; page < 5; page += 1) {
			const data = await list({ size: 50, emailId: cursor });
			seen.push(...data.list.map((r) => r.id));
			if (data.list.length < 50) break;
			cursor = Math.min(...data.list.map((r) => r.id));
		}

		expect(seen).toHaveLength(120);
		expect(new Set(seen).size).toBe(120);
		// Strictly descending across the whole walk.
		expect([...seen].sort((a, b) => b - a)).toEqual(seen);
	});

	it('reports `total` independently of the cursor position', async () => {
		await seed(120);
		const first = await list({ size: 50 });
		const cursor = Math.min(...first.list.map((r) => r.id));
		const second = await list({ size: 50, emailId: cursor });
		expect(first.total).toBe(120);
		expect(second.total).toBe(120);
	});
});

describe('starred filter', () => {
	it('narrows rows to starred only and scopes `total` to them', async () => {
		const ids = await seed(30);
		await starSome(ids, 3); // 10 starred

		const data = await list({ starred: 1 });
		expect(data.list).toHaveLength(10);
		// The pager divides by this number, so it must be the starred
		// count — not the mailbox count.
		expect(data.total).toBe(10);
		for (const row of data.list) {
			expect(row.isStar).toBe(1);
		}
	});

	it('is off by default and off for `starred=0`', async () => {
		const ids = await seed(30);
		await starSome(ids, 3);

		expect((await list()).list).toHaveLength(30);
		expect((await list({ starred: 0 })).list).toHaveLength(30);
		expect((await list({ starred: 0 })).total).toBe(30);
	});

	it('returns an empty page when nothing is starred', async () => {
		await seed(30);
		const data = await list({ starred: 1 });
		expect(data.list).toHaveLength(0);
		expect(data.total).toBe(0);
	});

	it('composes with the domain and localpart filters', async () => {
		const mine = await seed(12);
		const sales = await seed(12, `sales@${DOMAIN}`);
		await seed(12, `support@other.test`);
		// One starred row on each of my two mailboxes. The other
		// domain's rows are unstarred; a filter that ignored `domain=`
		// would still show 2 here, but a filter that ignored `to=`
		// would show 2 where it should show 1.
		await starSome(mine, 12);
		await starSome(sales, 12);

		const scoped = await list({ starred: 1, to: 'support' });
		expect(scoped.list).toHaveLength(1);
		expect(scoped.total).toBe(1);
		expect(scoped.list[0].toEmail).toBe(INBOX);

		// No `to=` → both starred rows on this domain.
		const domainWide = await list({ starred: 1 });
		expect(domainWide.list).toHaveLength(2);
		expect(domainWide.total).toBe(2);
	});

	it('does not leak starred rows from another mailbox into `idsFor`', async () => {
		// Guards the fixture helper itself: `idsFor` must only return
		// the addressed mailbox, otherwise the compose test below
		// would silently star the wrong rows.
		await seed(3);
		await seed(4, `sales@${DOMAIN}`);
		expect(await idsFor(`sales@${DOMAIN}`)).toHaveLength(4);
	});

	it('keeps the starred predicate inside the mailbox direction', async () => {
		const inbound = await seed(6);
		await starSome(inbound, 6);
		const outbound = await seed(6, INBOX, 'send');
		await starSome(outbound, 6);

		// One starred inbound + one starred outbound exist.
		const inbox = await list({ starred: 1 });
		expect(inbox.list).toHaveLength(1);
		expect(inbox.total).toBe(1);
		expect(inbox.list[0].type).toBe('receive');

		const sent = await list({ starred: 1, type: 'send' });
		expect(sent.list).toHaveLength(1);
		expect(sent.total).toBe(1);
		expect(sent.list[0].type).toBe('send');
	});

	it('pages over the starred set, not the whole mailbox', async () => {
		const ids = await seed(60);
		await starSome(ids, 3); // 20 starred
		const starredIds = ids.filter((_, i) => i % 3 === 0);

		const page1 = await list({ starred: 1, size: 10 });
		expect(page1.list).toHaveLength(10);
		expect(page1.total).toBe(20);

		const cursor = Math.min(...page1.list.map((r) => r.id));
		const page2 = await list({ starred: 1, size: 10, emailId: cursor });
		expect(page2.list).toHaveLength(10);

		const walked = [...page1.list, ...page2.list].map((r) => r.id);
		expect(new Set(walked).size).toBe(20);
		// Exactly the rows that were starred — no mailbox rows leaking
		// in between the starred ones.
		expect(walked.sort((a, b) => b - a)).toEqual(
			[...starredIds].sort((a, b) => b - a),
		);
	});

	it('reports `isStar` on unstarred rows when the filter is off', async () => {
		const ids = await seed(5);
		await starSome(ids, 5);
		const data = await list();
		expect(data.total).toBe(5);
		expect(data.list.filter((r) => r.isStar === 1)).toHaveLength(1);
	});
});

describe('junk list bounds', () => {
	it('defaults, honours and clamps `size` like the live mailbox', async () => {
		await seedJunk(120);

		expect((await listJunk()).list).toHaveLength(DEFAULT_PAGE_SIZE);
		expect((await listJunk({ size: 100 })).list).toHaveLength(MAX_PAGE_SIZE);
		expect((await listJunk({ size: 5000 })).list).toHaveLength(MAX_PAGE_SIZE);
		expect((await listJunk()).total).toBe(120);
	});
});