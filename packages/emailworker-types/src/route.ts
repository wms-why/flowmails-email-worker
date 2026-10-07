/**
 * Shared types for the receive-worker's receive-route table API
 * (`/api/route/get`, `/api/route/set`, `/api/route/clear`).
 *
 * Cloudflare Email Routing is no longer the enforcement point for a
 * domain's local-part allow-list. Each per-account worker keeps exactly
 * one Cloudflare catch-all rule pointing at itself, and decides inside
 * `src/service/email-receive.js` — before any body parsing — whether the
 * envelope recipient is on the list. The platform web worker owns the
 * list and pushes it here.
 *
 * Storage: the worker's own `kv` namespace (`flowmails-kv`, created and
 * bound by `deployWorker`), one key per domain. See
 * `apps/email-worker/src/service/route-service.js`.
 *
 * Wire-level contract:
 *   - Auth: `Authorization: Bearer <JWT_SECRET>` on all three routes
 *     (the per-account internal token, same as every other endpoint).
 *   - Success: HTTP 200 with the shared envelope
 *     (`{ code: 200, message, data }` — see `./envelope.ts`).
 *     A validation failure is HTTP 200 with a non-200 `code` in the
 *     body, so the proxy MUST inspect the envelope, not just `resp.ok`.
 *   - Availability: introduced in worker **1.4.0**. An older worker has
 *     no such route and answers plain `404`; the proxy maps that to a
 *     `ServiceError(409, "... upgrade ...")` so the user gets an
 *     actionable message instead of a silent no-op.
 *   - Consistency: Workers KV is eventually consistent (up to 60 s to
 *     propagate globally). The receive path only rejects when it has
 *     positively read a `rules` entry that does not list the local
 *     part; any read error falls open to `accept`.
 */

/**
 * Enforcement mode for one domain.
 *
 * - `"catchall"` — every address at the domain is received. This is
 *   also what a domain with **no** KV entry at all resolves to, so the
 *   platform never has to write a row for the default state.
 * - `"rules"` — only the local parts in {@link RouteRuleSet.localParts}
 *   are received; everything else is answered with a `550 5.1.1`
 *   rejection at the SMTP level and never reaches D1.
 */
export type RouteMode = "catchall" | "rules";

/**
 * The full routing policy for a single domain as stored in the worker's
 * KV (`route_rules:<domain>`). Returned by both `GET /api/route/get` and
 * `PUT /api/route/set`.
 */
export type RouteRuleSet = {
  /** Lower-cased domain name, e.g. `example.com`. The key is derived from it. */
  domain: string;
  /** See {@link RouteMode}. */
  mode: RouteMode;
  /**
   * Lower-cased, de-duplicated, sorted local parts. Always `[]` when
   * `mode === "catchall"` — the worker normalises it away so the stored
   * value is never self-contradictory.
   */
  localParts: string[];
  /** Epoch milliseconds of the last write. `0` when read from a legacy/hand-written value. */
  updatedAt: number;
};

/**
 * Body of `PUT /api/route/set`.
 *
 * Validation happens worker-side too (same regex the platform applies in
 * `validateLocalParts`) so a mis-shaped list can never reach KV even if
 * a caller bypasses `apps/web`.
 */
export type RouteRuleSetRequest = {
  /** Domain to scope the policy to. Normalised to lower case. */
  domain: string;
  mode: RouteMode;
  /**
   * Required and non-empty when `mode === "rules"`; ignored (and
   * cleared) when `mode === "catchall"`.
   */
  localParts?: string[];
};

/** Response body of `GET /api/route/get` / `PUT /api/route/set`. */
export type RouteRuleSetResponse = RouteRuleSet;

/**
 * Response body of `DELETE /api/route/clear`. The route is idempotent —
 * clearing a domain that has no entry still succeeds.
 */
export type RouteRuleClearResponse = {
  cleared: true;
};
