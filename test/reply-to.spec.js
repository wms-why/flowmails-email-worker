import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

/**
 * `replyTo` — the optional `Reply-To` header on the outbound path (1.5.1).
 *
 * The header was documented in the public SDK contract and accepted
 * by the SDK client, but three layers dropped it before it reached
 * Cloudflare's Email Services: the SDK backend's payload type, the
 * proxy body, and the worker's `dispatchOutbound` destructure. A
 * caller who set `replyTo` got a `201` and a delivered mail whose
 * replies went to the sending address instead.
 *
 * Two invariants live here.
 *
 * 1. **A malformed `replyTo` is an error, not a silent drop.**
 *    Cloudflare's Email Services builder discards an invalid
 *    `Reply-To` without complaining, so forwarding one would deliver
 *    a mail whose replies go somewhere the caller never asked for —
 *    and the caller would have no way to learn it. The worker
 *    validates it with the same `verifyUtils.isEmail` it applies to
 *    `from`, and answers with the standard `notEmail` error.
 *
 * 2. **"Unset" and "set to `from`" are different inputs.**
 *    An absent `replyTo` leaves the header off the envelope. That
 *    is not the same as explicitly setting it to the sending
 *    address: Cloudflare defaults an absent `Reply-To` to the
 *    envelope sender, so the two deliver identically — but only the
 *    explicit form shows up as a header the caller controls. The
 *    worker therefore omits the field entirely rather than
 *    substituting `from` for it.
 *
 * The Cloudflare Email Services binding is mocked: the real one is a
 * no-op stub under miniflare, and what matters here is the
 * `sendParams` the worker builds — the object that becomes the
 * envelope. Mocking it lets the specs assert on the header that
 * would have gone out, rather than on a delivered message nobody
 * can read.
 *
 * Runs against miniflare via `@cloudflare/vitest-pool-workers`; the
 * schema comes from the worker's own `/bootstrap` endpoint so the
 * specs run against the same tables production does.
 */

/** Every `sendParams` the worker handed to the Email Services binding. */
const sentEnvelopes = [];

vi.mock('../src/service/cf-email-service.js', () => ({
	default: {
		send: async (_env, params) => {
			sentEnvelopes.push(params);
			return { data: { id: 'smtp-message-id-1' }, error: null };
		},
	},
}));

const AUTH = { authorization: `Bearer ${env.JWT_SECRET}` };
const DOMAIN = 'replyto.test';
const FROM = `support@${DOMAIN}`;
const TO = 'customer@example.test';

async function call(path, init = {}) {
	return SELF.fetch(`http://example.com/api${path}`, {
		...init,
		headers: { ...AUTH, ...(init.headers || {}) },
	});
}

/**
 * POST /email/send and return the decoded envelope.
 *
 * The worker answers `200` with a `result.fail` body on a business
 * error (its envelope convention), so the HTTP status alone cannot
 * distinguish "sent" from "rejected" — the `code` field carries it.
 */
async function send(payload) {
	const res = await call('/email/send', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});
	expect(res.status).toBe(200);
	return res.json();
}

/** A minimal valid send payload; `replyTo` is layered on top. */
function payload(extra = {}) {
	return {
		from: FROM,
		to: [TO],
		subject: 'Order #1234',
		text: 'Thanks!',
		...extra,
	};
}

beforeAll(async () => {
	const res = await call('/bootstrap');
	expect(res.status).toBe(200);
});

beforeEach(async () => {
	sentEnvelopes.length = 0;
	await env.db.prepare(`DELETE FROM email`).run();
});

describe('replyTo — the outbound Reply-To header', () => {
	it('puts the caller\'s replyTo on the envelope', async () => {
		const body = await send(payload({ replyTo: 'replies@other.test' }));
		expect(body.code).toBe(200);
		expect(sentEnvelopes).toHaveLength(1);
		expect(sentEnvelopes[0].replyTo).toBe('replies@other.test');
		// The sending address is untouched — `replyTo` steers the
		// reply, it does not change who the mail is from.
		expect(sentEnvelopes[0].from).toBe(FROM);
	});

	it('rejects a malformed replyTo instead of dropping the header', async () => {
		// The whole point: Cloudflare's builder would discard this
		// silently, so the caller would never learn the reply was
		// going to the wrong place. The worker answers the standard
		// `notEmail` error instead.
		const body = await send(payload({ replyTo: 'not-an-email' }));
		expect(body.code).not.toBe(200);
		expect(body.message).toBe('非法邮箱'); // t('notEmail')
		// Nothing went out — the rejection happens before the
		// envelope is built.
		expect(sentEnvelopes).toHaveLength(0);
	});

	it('treats an empty replyTo as "unset", not as an error', async () => {
		// `replyTo: ""` means "no Reply-To header". It is a legal
		// input — the SDK's `replyTo` is optional, and a caller who
		// builds the payload from a nullable form field sends an
		// empty string rather than omitting the key.
		const body = await send(payload({ replyTo: '' }));
		expect(body.code).toBe(200);
		expect(sentEnvelopes).toHaveLength(1);
		expect(sentEnvelopes[0].replyTo).toBeUndefined();
	});

	it('omits the header entirely when no replyTo was given', async () => {
		// Deliberately NOT `replyTo: from`. An absent header and an
		// explicit one pointing at the sender deliver the same
		// message, but only the explicit form is a header the caller
		// set — and the worker does not invent one on the caller's
		// behalf.
		const body = await send(payload());
		expect(body.code).toBe(200);
		expect(sentEnvelopes).toHaveLength(1);
		expect(sentEnvelopes[0].replyTo).toBeUndefined();
	});

	it('does not let a malformed replyTo corrupt the stored row', async () => {
		// The validation happens before the INSERT, so a rejected
		// replyTo leaves no half-written row behind — the mail is
		// not sent, and it is not recorded as sent either.
		await send(payload({ replyTo: 'not-an-email' }));
		const { results } = await env.db
			.prepare(`SELECT id FROM email WHERE subject = ?1`)
			.bind('Order #1234')
			.all();
		expect(results).toHaveLength(0);
	});

	it('still records the send when the replyTo was accepted', async () => {
		await send(payload({ replyTo: 'replies@other.test' }));
		const { results } = await env.db
			.prepare(`SELECT status FROM email WHERE subject = ?1`)
			.bind('Order #1234')
			.all();
		expect(results).toHaveLength(1);
		expect(results[0].status).toBe(1); // SENT
	});
});
