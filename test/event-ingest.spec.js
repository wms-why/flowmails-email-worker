import {
	env,
	fetchMock,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import worker from '../src';
import eventIngestService from '../src/service/event-ingest-service';

/**
 * The producer side of the event spine (receive-worker 1.6.0).
 *
 * After a message is committed to D1, `email-receive.js` posts the
 * routing facts plus the subject line to the platform's
 * `/api/events/ingest` door. These tests pin the wire contract the
 * platform's allow-list accepts — version 2, subject included, no body —
 * and the best-effort rules: a missing binding skips, a 5xx retries
 * once, a 4xx does not, and a failure never breaks the receive path.
 */

const PLATFORM_ORIGIN = 'https://platform.test';
const INGEST_PATH = '/api/events/ingest';
const RSPAMD_ORIGIN = 'https://rspamd.test';
const RSPAMD_PATH = '/api/check';

const DOMAIN = 'event-ingest.test';
const INBOX = `support@${DOMAIN}`;
const AUTH = { authorization: `Bearer ${env.JWT_SECRET}` };

/** Only the two bindings the service reads; no D1 / KV / R2 needed. */
const testEnv = {
	PLATFORM_INGEST_URL: `${PLATFORM_ORIGIN}${INGEST_PATH}`,
	JWT_SECRET: env.JWT_SECRET,
};

function headersOf(headers) {
	return headers instanceof Headers ? headers : new Headers(headers);
}

beforeAll(async () => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
	const res = await SELF.fetch('http://example.com/api/bootstrap', {
		headers: AUTH,
	});
	expect(res.status).toBe(200);
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe('eventIngestService.reportInbound', () => {
	it('posts routing facts plus the subject with the worker bearer', async () => {
		let captured;
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(200, (opts) => {
				const headers = headersOf(opts.headers);
				captured = {
					body: JSON.parse(String(opts.body)),
					authorization: headers.get('authorization'),
					contentType: headers.get('content-type'),
				};
				return { ok: true };
			});

		const result = await eventIngestService.reportInbound(testEnv, {
			messageId: '<abc@example.test>',
			recipient: 'Support@Example.Test',
			sender: 'Sender@Example.Test',
			subject: '  Your invoice is ready  ',
		});

		expect(result).toMatchObject({
			reported: true,
			status: 200,
			attempt: 1,
		});
		expect(captured.body).toEqual({
			messageId: '<abc@example.test>',
			event: 'inbound.received',
			version: 2,
			recipient: 'Support@Example.Test',
			sender: 'Sender@Example.Test',
			subject: 'Your invoice is ready',
		});
		expect(captured.authorization).toBe(`Bearer ${env.JWT_SECRET}`);
		expect(captured.contentType).toBe('application/json');
	});

	it('omits an invalid sender and an empty subject rather than failing the event', async () => {
		let body;
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(200, (opts) => {
				body = JSON.parse(String(opts.body));
				return { ok: true };
			});

		const result = await eventIngestService.reportInbound(testEnv, {
			messageId: '<no-sender@example.test>',
			recipient: INBOX,
			sender: 'not-an-address',
			subject: '   ',
		});

		expect(result.reported).toBe(true);
		expect(body).toEqual({
			messageId: '<no-sender@example.test>',
			event: 'inbound.received',
			version: 2,
			recipient: INBOX,
		});
		expect(body.sender).toBeUndefined();
		expect(body.subject).toBeUndefined();
	});

	it('skips when PLATFORM_INGEST_URL is not configured', async () => {
		const result = await eventIngestService.reportInbound(
			{ JWT_SECRET: env.JWT_SECRET },
			{ messageId: '<x@example.test>', recipient: INBOX },
		);
		expect(result.reported).toBe(false);
		expect(result.reason).toMatch(/PLATFORM_INGEST_URL/);
	});

	it('skips a relative PLATFORM_INGEST_URL instead of retrying an invalid fetch', async () => {
		const result = await eventIngestService.reportInbound(
			{
				PLATFORM_INGEST_URL: '/api/events/ingest',
				JWT_SECRET: env.JWT_SECRET,
			},
			{ messageId: '<x@example.test>', recipient: INBOX },
		);
		expect(result.reported).toBe(false);
		expect(result.reason).toMatch(/absolute http/);
	});

	it('skips a message with no Message-ID — the log is keyed on it', async () => {
		const result = await eventIngestService.reportInbound(testEnv, {
			messageId: '   ',
			recipient: INBOX,
		});
		expect(result.reported).toBe(false);
		expect(result.reason).toMatch(/messageId/);
	});

	it('drops a subject that exceeds the platform bound but still reports the event', async () => {
		let body;
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(200, (opts) => {
				body = JSON.parse(String(opts.body));
				return { ok: true };
			});

		const result = await eventIngestService.reportInbound(testEnv, {
			messageId: '<long-subject@example.test>',
			recipient: INBOX,
			subject: 'x'.repeat(999),
		});

		expect(result.reported).toBe(true);
		expect(body.subject).toBeUndefined();
		expect(body.messageId).toBe('<long-subject@example.test>');
	});

	it('retries a 5xx once and succeeds', async () => {
		let calls = 0;
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(() => {
				calls += 1;
				return { statusCode: 503, data: { error: 'unavailable' } };
			});
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(() => {
				calls += 1;
				return { statusCode: 200, data: { ok: true } };
			});

		const result = await eventIngestService.reportInbound(testEnv, {
			messageId: '<retry@example.test>',
			recipient: INBOX,
		});

		expect(result).toMatchObject({
			reported: true,
			status: 200,
			attempt: 2,
		});
		expect(calls).toBe(2);
	});

	it('does not retry a 4xx — a contract or auth error will not fix itself', async () => {
		let calls = 0;
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(() => {
				calls += 1;
				return { statusCode: 400, data: { error: 'bad request' } };
			});

		const result = await eventIngestService.reportInbound(testEnv, {
			messageId: '<bad-request@example.test>',
			recipient: INBOX,
		});

		expect(result).toMatchObject({
			reported: false,
			status: 400,
			attempt: 1,
		});
		expect(calls).toBe(1);
	});

	it('never throws when the platform is unreachable', async () => {
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.replyWithError(new Error('network down'));
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.replyWithError(new Error('network down'));

		const result = await eventIngestService.reportInbound(testEnv, {
			messageId: '<offline@example.test>',
			recipient: INBOX,
		});

		expect(result.reported).toBe(false);
		expect(result.reason).toMatch(/network down/);
	});
});

describe('inbound handler — producer wiring', () => {
	beforeEach(async () => {
		await env.db
			.prepare(
				'DELETE FROM attachments WHERE email_id IN (SELECT id FROM email WHERE to_domain = ?1)',
			)
			.bind(DOMAIN)
			.run();
		await env.db.prepare('DELETE FROM email WHERE to_domain = ?1').bind(DOMAIN).run();
		await env.db.prepare('DELETE FROM unreadcount WHERE to_domain = ?1').bind(DOMAIN).run();
		await env.db.prepare('DELETE FROM junk_email WHERE to_domain = ?1').bind(DOMAIN).run();
	});

	it('reports a saved inbound message after completeReceive', async () => {
		let captured;
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(200, (opts) => {
				captured = JSON.parse(String(opts.body));
				return { ok: true };
			});
		fetchMock
			.get(RSPAMD_ORIGIN)
			.intercept({ path: RSPAMD_PATH, method: 'POST' })
			.reply(200, { action: 'no action', score: 0, required_score: 15 });

		const raw = [
			'From: Sender <sender@example.test>',
			`To: ${INBOX}`,
			'Subject: Hello from the test',
			'Message-ID: <event-1@example.test>',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'body',
		].join('\r\n');

		const ctx = createExecutionContext();
		await worker.email(
			{
				to: INBOX,
				from: 'sender@example.test',
				raw: new Response(raw).body,
				headers: new Headers(),
				setReject: () => {},
			},
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(captured).toEqual({
			messageId: '<event-1@example.test>',
			event: 'inbound.received',
			version: 2,
			recipient: INBOX,
			sender: 'sender@example.test',
			subject: 'Hello from the test',
		});

		const row = await env.db
			.prepare('SELECT status, message_id, subject FROM email WHERE to_domain = ?1')
			.bind(DOMAIN)
			.first();
		expect(row).toBeTruthy();
		expect(row.status).toBe(0);
		expect(row.message_id).toBe('<event-1@example.test>');
		expect(row.subject).toBe('Hello from the test');
	});

	it('saves the message even when the platform ingest fails', async () => {
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(503, { error: 'unavailable' });
		fetchMock
			.get(PLATFORM_ORIGIN)
			.intercept({ path: INGEST_PATH, method: 'POST' })
			.reply(503, { error: 'unavailable' });
		fetchMock
			.get(RSPAMD_ORIGIN)
			.intercept({ path: RSPAMD_PATH, method: 'POST' })
			.reply(200, { action: 'no action', score: 0, required_score: 15 });

		const raw = [
			'From: Sender <sender@example.test>',
			`To: ${INBOX}`,
			'Subject: Still delivered',
			'Message-ID: <event-2@example.test>',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'body',
		].join('\r\n');

		const ctx = createExecutionContext();
		await worker.email(
			{
				to: INBOX,
				from: 'sender@example.test',
				raw: new Response(raw).body,
				headers: new Headers(),
				setReject: () => {},
			},
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		const row = await env.db
			.prepare('SELECT status, message_id FROM email WHERE to_domain = ?1')
			.bind(DOMAIN)
			.first();
		expect(row).toBeTruthy();
		expect(row.message_id).toBe('<event-2@example.test>');
	});
});
