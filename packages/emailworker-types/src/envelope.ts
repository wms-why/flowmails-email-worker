/**
 * Shared envelope types for the `flowmails-receive-worker` HTTP API.
 *
 * Every endpoint in `apps/email-worker/src/api/**` wraps its payload in
 * the `src/utils/result.js` helper:
 *
 * ```js
 * result.ok(data)   // { code: 200, message: 'success', data }
 * result.fail(msg)  // { code, message }
 * ```
 *
 * The platform web worker (`apps/web/app/server/integrations/email-worker-proxy.ts`)
 * reads `code` to decide success vs failure, then unpacks `data` into
 * one of the request-specific shapes declared in this submodule.
 *
 * Use {@link EmailWorkerResult} as the response type of any helper that
 * proxies a worker endpoint, and {@link EmailWorkerError} for the
 * failure branch (which the worker emits for any non-200 `result.fail`).
 */

// ---------------------------------------------------------------------------
// Status codes emitted by the email-worker's `result` helper.
// ---------------------------------------------------------------------------

/**
 * Numeric status code embedded in the {@link EmailWorkerResult} envelope.
 *
 * The receive-worker uses `200` for every successful response (the
 * `result.ok(...)` helper hard-codes it) regardless of the underlying
 * HTTP status. The platform web worker reads `code` to decide success
 * and treats anything other than `200` as a worker-side business
 * error. The raw HTTP status (4xx/5xx) is preserved by Hono and
 * surfaced separately by the proxy's `Response` handle.
 */
export type EmailWorkerResultCode = 200 | number;

// ---------------------------------------------------------------------------
// Response envelope.
// ---------------------------------------------------------------------------

/**
 * The shape every successful email-worker response conforms to. Mutating
 * endpoints (`/api/email/read`, `/api/email/delete`, etc.) emit
 * `data: null`; readers must allow for that.
 *
 * The platform web worker decodes this with `JSON.parse` and dispatches
 * on `code === 200`. See `apps/web/app/server/integrations/email-worker-proxy.ts`
 * for the only consumer.
 *
 * @typeParam T - The `data` payload shape for the specific endpoint.
 *                Use `unknown` (or the union of all possible shapes) for
 *                helpers that proxy multiple endpoints.
 */
export type EmailWorkerResult<T> = {
  /** Worker-side status. `200` is the only success value the worker emits. */
  code: EmailWorkerResultCode;
  /** Human-readable, English-only message; the web side never surfaces this directly. */
  message: string;
  /** Endpoint-specific payload. `null` for endpoints that return no body. */
  data: T | null;
};

/**
 * Failure envelope. The receive-worker emits this for any `BizError` /
 * caught exception; `code` mirrors the HTTP status Hono would have used
 * (4xx for validation, 5xx for unexpected). The platform web worker
 * converts these into a thrown `ServiceError` rather than returning
 * the raw envelope to the browser.
 */
export type EmailWorkerError = {
  code: EmailWorkerResultCode;
  message: string;
  data?: null;
};

// ---------------------------------------------------------------------------
// HTTP method / URL conventions used by the proxy helpers.
// ---------------------------------------------------------------------------

/**
 * HTTP methods the receive-worker accepts. The platform proxy only
 * dispatches GET / POST / PUT / DELETE; any other method would have to
 * be added here before the proxy learns it.
 */
export type EmailWorkerHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Convenience alias for the response handle the proxy hands back to
 * its callers. Callers `.json()` / `.text()` it themselves so the
 * proxy stays format-agnostic.
 */
export type EmailWorkerHttpResponse = Response;

// ---------------------------------------------------------------------------
// Pagination / cursor helpers shared by the list endpoints.
// ---------------------------------------------------------------------------

/**
 * Cursor pagination request. The worker's `list` / `latest` endpoints
 * take a `size` cap (capped at 30 server-side) and an `emailId`
 * cursor — when set, only rows with `id > emailId` are returned, so
 * callers page by walking the descending id list returned by the
 * previous call.
 */
export type EmailWorkerPaginationParams = {
  /**
   * Maximum number of rows to return. The worker silently clamps this
   * to 30; callers don't need to enforce their own ceiling.
   */
  size?: number;
  /**
   * Cursor: only rows with `id > emailId` are returned. Omit on the
   * first page.
   */
  emailId?: number;
};
