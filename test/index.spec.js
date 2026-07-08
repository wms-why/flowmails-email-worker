import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

/**
 * Smoke tests for the receive-worker entry point.
 *
 * The `fetch` handler in `src/index.js` strips the `/api` prefix and dispatches
 * to Hono; `email` and `scheduled` are tested by their own service specs.
 */
describe('worker entry — /api/ok smoke', () => {
	it('returns "ok" via direct worker.fetch()', async () => {
		const request = new Request('http://example.com/api/ok');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toBe('ok');
	});

	it('returns "ok" via SELF (integration style)', async () => {
		const response = await SELF.fetch('http://example.com/api/ok');
		expect(await response.text()).toBe('ok');
	});

	it('strips the /api prefix before dispatching to Hono', async () => {
		const request = new Request('http://example.com/api/ok');
		const response = await SELF.fetch(request);
		expect(response.status).toBe(200);
	});
});