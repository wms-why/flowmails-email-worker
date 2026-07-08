/**
 * Shared types for the receive-worker's `/api/bootstrap` endpoint.
 *
 * `/api/bootstrap` is the worker's one-shot system endpoint: it runs the
 * version-gated D1 migrations (`apps/email-worker/src/service/bootstrap-service.js`)
 * and writes the resulting `LAST_VERSION` to KV. Every other endpoint
 * assumes the schema is already in place — a freshly-created D1 will
 * 500 on the first list/read/send until `/api/bootstrap` has been
 * called.
 *
 * Wire-level contract:
 *   - Path:    `GET /api/bootstrap`
 *   - Auth:    `Authorization: Bearer <JWT_SECRET>` (the per-account
 *              internal token — same as every other worker endpoint).
 *              `/bootstrap` is in the auth whitelist `a1` set inside
 *              `service/security.js`, but the `verifyToken` branch is
 *              still the only path that passes the middleware; a
 *              developer API key hits the `forbidden` branch on this
 *              endpoint.
 *   - Success: HTTP 200, body is the localized "init success" string
 *              from `src/i18n/i18n.js#t('initSuccess')` (plain text,
 *              NOT the JSON `result.ok(...)` envelope the other
 *              endpoints emit). Migrate failures bubble up as Hono
 *              exceptions and surface as 5xx.
 *
 * The platform web worker must call this once per worker after deploy
 * and again after every redeploy that bumps the worker version. See
 * `apps/web/app/server/services/onboarding-service.ts` and
 * `apps/web/app/server/services/platform-service.ts` for the eager
 * call sites, and
 * `apps/web/app/server/integrations/email-worker-proxy.ts`
 * `resolveEmailWorkerForDomain` for the lazy self-heal that runs on
 * the next worker call when `worker.bootstrapped === 0`.
 */

/**
 * Response body for `GET /api/bootstrap` on success. Plain text — the
 * localized success message. The proxy treats any 200 as success and
 * does not parse this string; it exists so callers can render it in
 * logs / error surfaces if needed.
 */
export type BootstrapResponse = string;