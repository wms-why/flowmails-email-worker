import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import routeService from '../src/service/route-service';
import KvConst from '../src/const/kv-const';

/**
 * Receive route table — KV storage + the three `/api/route/*` endpoints.
 *
 * These run against miniflare via `@cloudflare/vitest-pool-workers`, which
 * picks up the `kv` binding declared in `wrangler-dev.toml`.
 */

const AUTH = { authorization: `Bearer ${env.JWT_SECRET}` };
const DOMAIN = 'example.com';

async function callRoute(path, init = {}) {
	return SELF.fetch(`http://example.com/api${path}`, {
		...init,
		headers: { ...AUTH, ...(init.headers || {}) },
	});
}

beforeEach(async () => {
	await env.kv.delete(KvConst.ROUTE_RULES + DOMAIN);
});

describe('route rules — KV storage', () => {
	it('treats a missing key as "no table" (= catch-all)', async () => {
		expect(await routeService.get(env, DOMAIN)).toBeNull();
	});

	it('round-trips a rules entry', async () => {
		const written = await routeService.set(env, DOMAIN, 'rules', ['Sales', 'support', 'sales']);
		expect(written.mode).toBe('rules');
		expect(written.domain).toBe(DOMAIN);
		// lower-cased, de-duplicated, sorted
		expect(written.localParts).toEqual(['sales', 'support']);

		const read = await routeService.get(env, DOMAIN);
		expect(read.mode).toBe('rules');
		expect(read.localParts).toEqual(['sales', 'support']);
		expect(read.updatedAt).toBeGreaterThan(0);
	});

	it('clears localParts in catch-all mode so the value is never self-contradictory', async () => {
		await routeService.set(env, DOMAIN, 'rules', ['support']);
		const written = await routeService.set(env, DOMAIN, 'catchall', ['support']);
		expect(written.mode).toBe('catchall');
		expect(written.localParts).toEqual([]);
	});

	it('normalises the domain, so A@EXAMPLE.COM and a@example.com share one key', async () => {
		await routeService.set(env, 'EXAMPLE.COM', 'rules', ['support']);
		const read = await routeService.get(env, ` ${DOMAIN} `);
		expect(read.domain).toBe(DOMAIN);
		expect(read.localParts).toEqual(['support']);
	});

	it('rejects a malformed list rather than writing it to KV', async () => {
		await expect(routeService.set(env, DOMAIN, 'rules', [])).rejects.toThrow();
		await expect(routeService.set(env, DOMAIN, 'rules', ['sup..port'])).rejects.toThrow();
		await expect(routeService.set(env, DOMAIN, 'rules', ['-support'])).rejects.toThrow();
		await expect(routeService.set(env, DOMAIN, 'nonsense', [])).rejects.toThrow();
		expect(await routeService.get(env, DOMAIN)).toBeNull();
	});

	it('clear is idempotent', async () => {
		expect(await routeService.clear(env, DOMAIN)).toEqual({ cleared: true });
		await routeService.set(env, DOMAIN, 'rules', ['support']);
		expect(await routeService.clear(env, DOMAIN)).toEqual({ cleared: true });
		expect(await routeService.get(env, DOMAIN)).toBeNull();
	});
});

describe('route rules — decide() (the receive hot path)', () => {
	it('accepts everything when no table exists', async () => {
		expect(await routeService.decide(env, 'anyone@' + DOMAIN)).toEqual({ action: 'accept' });
	});

	it('accepts everything in catch-all mode', async () => {
		await routeService.set(env, DOMAIN, 'catchall', []);
		expect((await routeService.decide(env, 'anyone@' + DOMAIN)).action).toBe('accept');
	});

	it('accepts listed local parts and rejects the rest', async () => {
		await routeService.set(env, DOMAIN, 'rules', ['support', 'sales']);
		expect((await routeService.decide(env, 'support@' + DOMAIN)).action).toBe('accept');
		expect((await routeService.decide(env, 'sales@' + DOMAIN)).action).toBe('accept');
		// comparison is case-insensitive on the whole address
		expect((await routeService.decide(env, 'Support@EXAMPLE.COM')).action).toBe('accept');
		expect((await routeService.decide(env, 'billing@' + DOMAIN)).action).toBe('reject');
	});

	it('rejects every address when rules mode has an empty list', async () => {
		// `set` refuses an empty list, so build the value the only way a
		// hand-edited KV entry could: catch-all then a manual overwrite.
		await env.kv.put(
			KvConst.ROUTE_RULES + DOMAIN,
			JSON.stringify({ domain: DOMAIN, mode: 'rules', localParts: [], updatedAt: Date.now() }),
		);
		expect((await routeService.decide(env, 'support@' + DOMAIN)).action).toBe('reject');
	});

	it('fails open on a malformed stored value', async () => {
		await env.kv.put(KvConst.ROUTE_RULES + DOMAIN, 'not json at all');
		expect((await routeService.decide(env, 'anyone@' + DOMAIN)).action).toBe('accept');
	});

	it('fails open on a KV read error, so an outage never drops user mail', async () => {
		const broken = {
			kv: {
				get: () => {
					throw new Error('KV unavailable');
				},
			},
		};
		expect((await routeService.decide(broken, 'anyone@' + DOMAIN)).action).toBe('accept');
	});

	it('leaves malformed addresses to the existing pipeline', async () => {
		await routeService.set(env, DOMAIN, 'rules', ['support']);
		expect((await routeService.decide(env, 'not-an-address')).action).toBe('accept');
	});
});

describe('route rules — HTTP API', () => {
	it('requires the per-account JWT', async () => {
		// `security.js` throws `BizError`, which `hono.js#onError` renders
		// through `result.fail(...)` — so the rejection is HTTP 200 with a
		// non-200 `code` in the body. Same reason the platform proxy has to
		// read the envelope instead of trusting `resp.ok`.
		const res = await SELF.fetch('http://example.com/api/route/get?domain=' + DOMAIN);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.code).toBe(401);
		expect(body.data).toBeUndefined();
	});

	it('PUT /route/set then GET /route/get', async () => {
		const put = await callRoute('/route/set', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ domain: DOMAIN, mode: 'rules', localParts: ['support'] }),
		});
		expect(put.status).toBe(200);
		expect((await put.json()).code).toBe(200);

		const get = await callRoute(`/route/get?domain=${DOMAIN}`);
		const body = await get.json();
		expect(body.code).toBe(200);
		expect(body.data.mode).toBe('rules');
		expect(body.data.localParts).toEqual(['support']);
	});

	it('DELETE /route/clear returns the cleared envelope', async () => {
		await routeService.set(env, DOMAIN, 'rules', ['support']);
		const res = await callRoute(`/route/clear?domain=${DOMAIN}`, { method: 'DELETE' });
		const body = await res.json();
		expect(body.code).toBe(200);
		expect(body.data).toEqual({ cleared: true });
		expect(await routeService.get(env, DOMAIN)).toBeNull();
	});

	it('surfaces validation failures as a non-200 code in the envelope, not an HTTP error', async () => {
		// The platform proxy must inspect `code`, not just `resp.ok` —
		// Hono renders `BizError` through `result.fail(...)` with HTTP 200.
		const res = await callRoute('/route/set', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ domain: DOMAIN, mode: 'rules', localParts: ['bad..part'] }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.code).not.toBe(200);
		// `result.fail` omits `data` entirely rather than nulling it.
		expect(body.data ?? null).toBeNull();
	});
});
