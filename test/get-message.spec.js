import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

/**
 * `GET /email/get` — the two lookup keys (1.5.1).
 *
 * The endpoint used to take a numeric `emailId` and nothing else,
 * which was fine for the dashboard: it renders the row, so it has the
 * id. The agent platform is the other caller, and it holds a
 * different key — its event log records the SMTP `Message-ID`, not
 * the row id, because the row id never crosses the boundary between
 * the worker and the platform. An agent that read an event could
 * therefore see that mail arrived and could not fetch what it said.
 *
 * Both keys now resolve, against the same IDOR check, and sending
 * both is rejected rather than resolved.
 */

const AUTH = { authorization: `Bearer ${env.JWT_SECRET}` };
const DOMAIN = 'getone.test';
const INBOX = `support@${DOMAIN}`;

async function call(path, init = {}) {
	return SELF.fetch(`http://example.com/api${path}`, {
		...init,
		headers: { ...AUTH, ...(init.headers || {}) },
	});
}

/**
 * Insert one row and return its numeric id.
 *
 * `messageId` is deliberately nullable: a real inbound message may
 * arrive with no `Message-ID` header, in which case the worker stores
 * an empty string. That case is what makes `messageId=` dangerous
 * without a guard — every such row shares the key.
 */
async function seed({ messageId, to = INBOX, subject = 'hello' } = {}) {
	const { meta } = await env.db
		.prepare(
			`INSERT INTO email (from_email, to_email, subject, text, type, status, unread, message_id)
			 VALUES (?1, ?2, ?3, 'body', 'receive', 0, 1, ?4)`,
		)
		.bind('sender@example.test', to, subject, messageId ?? '')
		.run();
	return Number(meta.last_row_id);
}

/** GET /email/get and return the decoded envelope. */
async function getOne(params) {
	const qs = new URLSearchParams(params).toString();
	const res = await call(`/email/get?${qs}`);
	expect(res.status).toBe(200);
	return res.json();
}

beforeAll(async () => {
	const res = await call('/bootstrap');
	expect(res.status).toBe(200);
});

beforeEach(async () => {
	await env.db.prepare(`DELETE FROM email`).run();
});

describe('getOne — lookup by row id', () => {
	it('finds the row by emailId', async () => {
		const id = await seed({ messageId: '<one@example.test>' });
		const body = await getOne({ emailId: String(id), domain: DOMAIN });
		expect(body.code).toBe(200);
		expect(body.data.id).toBe(id);
		expect(body.data.subject).toBe('hello');
	});

	it('still enforces the domain check on the id path', async () => {
		const id = await seed({ messageId: '<one@example.test>' });
		const body = await getOne({ emailId: String(id), domain: 'other.test' });
		expect(body.code).not.toBe(200);
	});
});

describe('getOne — lookup by Message-ID', () => {
	it('finds the row by messageId', async () => {
		// This is the agent's path: the event log carries this string,
		// never the row id.
		const id = await seed({ messageId: '<abc123@example.test>' });
		const body = await getOne({
			messageId: '<abc123@example.test>',
			domain: DOMAIN,
		});
		expect(body.code).toBe(200);
		expect(body.data.id).toBe(id);
		expect(body.data.subject).toBe('hello');
	});

	it('returns the full body, not a preview', async () => {
		// The whole point of the fetch is the content the event
		// deliberately does not carry.
		await seed({ messageId: '<full@example.test>' });
		const body = await getOne({
			messageId: '<full@example.test>',
			domain: DOMAIN,
		});
		expect(body.data.text).toBe('body');
	});

	it('enforces the domain check on the messageId path too', async () => {
		// A new lookup key must not become an IDOR hole: the same
		// domain predicate guards it.
		await seed({ messageId: '<abc123@example.test>' });
		const body = await getOne({
			messageId: '<abc123@example.test>',
			domain: 'other.test',
		});
		expect(body.code).not.toBe(200);
	});

	it('reports a miss rather than matching a row with no Message-ID', async () => {
		// Rows with no `Message-ID` header store an empty string. A
		// lookup for an unknown id must not fall through to one of
		// them — that would hand an agent somebody else's message.
		await seed({ messageId: undefined });
		const body = await getOne({
			messageId: '<does-not-exist@example.test>',
			domain: DOMAIN,
		});
		expect(body.code).not.toBe(200);
	});

	it('accepts a messageId that carries angle brackets', async () => {
		// SMTP Message-IDs are `<local@domain>` in the header and the
		// worker stores the value verbatim, brackets included.
		await seed({ messageId: '<bracketed@example.test>' });
		const body = await getOne({
			messageId: '<bracketed@example.test>',
			domain: DOMAIN,
		});
		expect(body.code).toBe(200);
	});
});

describe('getOne — both keys', () => {
	it('rejects a request that sends both, rather than picking one', async () => {
		// Which key wins would be a precedence the caller cannot
		// see, so it is a caller bug.
		const id = await seed({ messageId: '<both@example.test>' });
		const body = await getOne({
			emailId: String(id),
			messageId: '<both@example.test>',
			domain: DOMAIN,
		});
		expect(body.code).not.toBe(200);
	});

	it('rejects a request that sends neither', async () => {
		const body = await getOne({ domain: DOMAIN });
		expect(body.code).not.toBe(200);
	});
});
