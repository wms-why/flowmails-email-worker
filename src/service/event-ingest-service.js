// Event ingest — the producer side of the platform's durable event log.
//
// The receive worker runs inside the user's Cloudflare account, so it
// cannot push to a Flowmails-owned queue. After an inbound message has
// been committed to D1, this module POSTs the routing facts plus the
// subject line to the platform's `/api/events/ingest` door. The body and
// attachments stay here; the platform's allow-list rejects them.
//
// Auth is the per-account `JWT_SECRET` the worker already uses for
// `/api/check` and `/api/email/*` — no new credential surface.
//
// Reporting is best-effort and never blocks the SMTP return:
// `email-receive.js` schedules it with `ctx.waitUntil`. The platform's
// ingest is idempotent on `(user_id, message_id, event_type)`, so a
// retry after a timeout is safe. A failure is logged and dropped; the
// message is already in D1, and the event log is a trigger, not the
// mailbox.
//
// `PLATFORM_INGEST_URL` is stamped per account by the platform's
// `deployWorker` / `redeployWorker` (see
// `apps/web/app/server/integrations/cloudflare-worker-service.ts`).
// A worker that has not been redeployed since 1.6.0 simply has no
// binding and skips the report.

const PAYLOAD_VERSION = 2;
const EVENT_TYPE = 'inbound.received';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

// These mirror the platform's allow-list bounds in
// `apps/web/app/server/services/automation/contract.ts`. They are
// duplicated because the worker is a separate repository and the values
// are part of the wire contract, not an implementation detail.
const MAX_MESSAGE_ID_LENGTH = 256;
const MAX_ADDRESS_LENGTH = 320;
const MAX_SUBJECT_LENGTH = 998;

// A missing binding is a deployment problem, not a per-message problem.
// Log it once per isolate instead of once per inbound email.
let warnedMissingUrl = false;
let warnedMissingToken = false;

const eventIngestService = {
	/**
	 * Report one accepted inbound message.
	 *
	 * @param {object} env Worker bindings (`PLATFORM_INGEST_URL`,
	 *                     `JWT_SECRET`).
	 * @param {object} message
	 * @param {string} message.messageId SMTP `Message-ID` (required; an
	 *                                   empty one cannot be looked up).
	 * @param {string} message.recipient Envelope recipient.
	 * @param {string} [message.sender]  Parsed `From:` address.
	 * @param {string} [message.subject] Decoded subject line.
	 * @returns {Promise<{
	 *   reported: boolean,
	 *   status?: number,
	 *   attempt?: number,
	 *   reason?: string,
	 * }>}
	 */
	async reportInbound(env, message) {
		const url = String(env?.PLATFORM_INGEST_URL || '').trim();
		if (!url) {
			if (!warnedMissingUrl) {
				console.warn('[event-ingest] PLATFORM_INGEST_URL is not configured; inbound events will not be reported');
				warnedMissingUrl = true;
			}
			return skip('PLATFORM_INGEST_URL is not configured');
		}
		if (!isHttpUrl(url)) {
			console.warn('[event-ingest] PLATFORM_INGEST_URL is not an absolute http(s) URL; skipping inbound event');
			return skip('PLATFORM_INGEST_URL is not an absolute http(s) URL');
		}

		const token = env?.JWT_SECRET;
		if (!token) {
			if (!warnedMissingToken) {
				console.warn('[event-ingest] JWT_SECRET is not configured; inbound events will not be reported');
				warnedMissingToken = true;
			}
			return skip('JWT_SECRET is not configured');
		}

		const messageId = String(message?.messageId || '').trim();
		if (!messageId) {
			// Some senders strip the header. The platform's log is keyed on
			// the Message-ID and the agent fetches by it, so there is no
			// usable event to record.
			return skip('messageId is empty');
		}
		if (messageId.length > MAX_MESSAGE_ID_LENGTH) {
			console.warn('[event-ingest] messageId is too long; skipping inbound event');
			return skip('messageId is too long');
		}

		const recipient = String(message?.recipient || '').trim();
		if (!isEmailAddress(recipient)) {
			console.warn('[event-ingest] recipient is not a valid address; skipping inbound event');
			return skip('recipient is not a valid address');
		}

		const payload = {
			messageId,
			event: EVENT_TYPE,
			version: PAYLOAD_VERSION,
			recipient,
		};

		const sender = String(message?.sender || '').trim();
		if (isEmailAddress(sender)) {
			payload.sender = sender;
		}

		const subject = String(message?.subject || '').trim();
		if (subject) {
			if (subject.length <= MAX_SUBJECT_LENGTH) {
				payload.subject = subject;
			} else {
				// The subject is optional; a malformed one must not cost the
				// whole event. Routing facts still reach the log.
				console.warn('[event-ingest] subject is too long; reporting without it');
			}
		}

		let lastError = 'fetch failed';
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${token}`,
					},
					body: JSON.stringify(payload),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				if (response.ok) {
					return { reported: true, status: response.status, attempt };
				}

				lastError = `ingest responded ${response.status}`;
				if (!isRetryableStatus(response.status)) {
					console.warn(`[event-ingest] ${lastError}; not retrying`);
					return {
						reported: false,
						status: response.status,
						attempt,
						reason: lastError,
					};
				}
			} catch (err) {
				lastError = err instanceof Error ? err.message : 'fetch failed';
			}

			if (attempt < MAX_ATTEMPTS) {
				await sleep(RETRY_DELAY_MS);
			}
		}

		console.warn(`[event-ingest] ${lastError}; gave up after ${MAX_ATTEMPTS} attempts`);
		return { reported: false, reason: lastError };
	},
};

function isRetryableStatus(status) {
	return status >= 500 || status === 408 || status === 429;
}

function isHttpUrl(value) {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:';
	} catch {
		return false;
	}
}

// Mirrors the platform's `isEmailAddress` check. The worker sends the
// sender only when it looks deliverable; a malformed `From:` header
// should cost the optional field, not the event.
function isEmailAddress(raw) {
	const value = String(raw || '').trim();
	if (!value || value.length > MAX_ADDRESS_LENGTH || /\s/.test(value)) {
		return false;
	}
	const at = value.indexOf('@');
	if (at <= 0 || at === value.length - 1) {
		return false;
	}
	const domain = value.slice(at + 1);
	return domain.includes('.') && !domain.includes('@');
}

function skip(reason) {
	return { reported: false, reason };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default eventIngestService;
