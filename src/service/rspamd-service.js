// Rspamd integration.
//
// After every inbound receive (see `email-receive.js#email`), the
// worker POSTs the raw RFC822 message body to the platform's
// `/api/check` proxy at `env.RSPAMD_CHECK_URL` (defaulting to
// `https://flowmail.net/api/check`) and asks "is this spam /
// phishing?". The proxy lives on the platform web worker
// (`apps/web/app/routes/api.check.ts`) — the email-worker never
// talks directly to the upstream Rspamd service. Auth is
// `Authorization: Bearer ${env.JWT_SECRET}` (the same per-account
// secret the worker already uses for /api/email/* traffic); the
// web worker validates the bearer against an O(1) KV hash lookup
// (`jwt_secret_lookup:<sha256>` records registered on every
// deploy by
// `apps/web/app/server/integrations/jwt-secret-lookup.ts`), then
// forwards the request to upstream Rspamd using its own
// shared `RSPAMD_UPSTREAM_TOKEN`. The upstream's JSON response is
// passed back to this worker verbatim.
//
// Response shape (see the `curl` example in
// `apps/web/app/routes/dashboard.emailbox.tsx`'s notes):
//
//   {
//     "is_skipped":   false,
//     "score":         24.4,
//     "required_score": 15.0,
//     "action":        "reject" | "add header" | "greylist" | "ham" | ...,
//     "thresholds":    { "reject": 15, "add header": 6, "greylist": 4 },
//     "symbols":       { MISSING_TO: { score: 2.0, ... }, ... },
//     ...
//   }
//
// Classification rule (per the user spec): `isJunk ⇔ action === "reject"`.
// Rspamd's own action label is the canonical verdict; we trust it
// rather than re-implementing the score-vs-required comparison.
//
// The check runs in `ctx.waitUntil` — failures are logged and the
// email stays in the live `email` table (fail-open). The user
// would rather see a borderline message in Inbox than miss a real
// one because the classifier hiccupped.

const DEFAULT_CHECK_URL = 'https://flowmail.net/api/check';
const CHECK_TIMEOUT_MS = 5000;

const rspamdService = {
	/**
	 * Score a single inbound message.
	 *
	 * @param {object} env  Worker bindings (needs `JWT_SECRET` and
	 *                     optionally `RSPAMD_CHECK_URL`).
	 * @param {object} args
	 * @param {string} args.rawBody  Full RFC822 message body
	 *                               (decoded once by `email-receive.js`
	 *                               so we don't double-read
	 *                               `message.raw`).
	 * @param {string} args.fromEmail  Envelope sender (the `From:`
	 *                                 header value parsed by
	 *                                 PostalMime).
	 * @param {string} args.toEmail  Envelope recipient (the `message.to`
	 *                               value Cloudflare routes on).
	 * @returns {Promise<{
	 *   isJunk: boolean,
	 *   score: number,
	 *   requiredScore: number,
	 *   action: string,
	 *   thresholds: object | null,
	 *   symbols: string | null,   // JSON-encoded
	 *   raw: object | null,
	 *   error: string | null,
	 * }>}
	 */
	async checkEmail(env, args) {
		const { rawBody, fromEmail, toEmail } = args;
		const url = env.RSPAMD_CHECK_URL || DEFAULT_CHECK_URL;
		const token = env.JWT_SECRET;

		// Guard rails — every input is required for the wire
		// contract the classifier expects. Missing any of them is
		// a programming error, not a runtime hiccup, so we fail
		// open with an explicit reason rather than throwing.
		if (!token) {
			return failOpen('JWT_SECRET is not configured');
		}
		if (!rawBody) {
			return failOpen('rawBody is empty');
		}

		let response;
		try {
			response = await fetch(url, {
				method: 'POST',
				headers: {
					// The classifier's contract is plain text +
					// metadata headers — matches the `curl`
					// example in the docs. The body is the raw
					// RFC822 message; the classifier parses it
					// itself.
					'content-type': 'text/plain; charset=utf-8',
					authorization: `Bearer ${token}`,
					from: String(fromEmail || ''),
					recipient: String(toEmail || ''),
				},
				body: rawBody,
				signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
			});
		} catch (err) {
			return failOpen(err instanceof Error ? err.message : 'fetch failed');
		}

		if (!response.ok) {
			return failOpen(`classifier responded ${response.status}`);
		}

		let payload;
		try {
			payload = await response.json();
		} catch (err) {
			return failOpen(err instanceof Error ? err.message : 'invalid JSON');
		}

		// Defensive defaults: a payload missing the verdict
		// fields is treated as "not junk" with score 0 rather
		// than crashing the receive pipeline.
		const score = numberOr(payload.score, 0);
		const requiredScore = numberOr(payload.required_score, 0);
		const action = typeof payload.action === 'string' ? payload.action : 'no action';
		const isJunk = action === 'reject';

		let symbols = null;
		if (payload.symbols && typeof payload.symbols === 'object') {
			try {
				symbols = JSON.stringify(payload.symbols);
			} catch {
				symbols = null;
			}
		}

		return {
			isJunk,
			score,
			requiredScore,
			action,
			thresholds: payload.thresholds && typeof payload.thresholds === 'object' ? payload.thresholds : null,
			symbols,
			raw: payload,
			error: null,
		};
	},
};

function numberOr(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function failOpen(reason) {
	return {
		isJunk: false,
		score: 0,
		requiredScore: 0,
		action: 'no action',
		thresholds: null,
		symbols: null,
		raw: null,
		error: reason,
	};
}

export default rspamdService;
