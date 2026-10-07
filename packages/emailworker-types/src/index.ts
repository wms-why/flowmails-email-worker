/**
 * Public surface of the email-worker API submodule.
 *
 * Re-exports every type the platform web worker needs to type the
 * helpers in `apps/web/app/server/integrations/email-worker-proxy.ts`
 * — request bodies, response payloads, and the row shapes the
 * worker returns. Importers should pull from
 * `@flowmails/shared/emailworker` (or the top-level barrel in
 * `index.ts` of the package) rather than the sibling files; the
 * split exists to keep each file's surface readable, not to
 * advertise a stable per-file API.
 *
 * Conventions:
 * - Request shapes use the `Request` suffix.
 * - Response shapes use the `Response` suffix.
 * - Row / envelope shapes use the domain noun (`EmailListRow`,
 *   `AttachmentInList`, `EmailSendResult`, ...).
 * - The shared envelope (success/failure) lives in `./envelope.ts`.
 *
 * The package is **source-direct**; this barrel is consumed via
 * `export * from "./emailworker/index.ts"` in the package's main
 * `index.ts`. The `.ts` extension on the re-export matches the
 * pattern used for `./types.ts` and friends.
 */

export * from "./envelope.ts";
export * from "./email.ts";
export * from "./ai-agent.ts";
export * from "./analysis.ts";
export * from "./bootstrap.ts";
export * from "./route.ts";
