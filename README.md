# @flowmails/email-worker

Cloudflare Worker that receives inbound email for [Flowmails](https://flowmails.net) users, persists messages to D1, stores attachments on R2, and exposes a typed REST surface (`/api/*`) for the platform web app and the SDK backend to consume.

This package is the per-account receive-worker that Flowmails deploys once per `(user, accountId)` pair onto the user's own Cloudflare account.

## About Flowmails

[Flowmails](https://flowmails.net) is a self-hosted email platform on Cloudflare — your inbox, outbox, and webhooks live in your own D1, no SMTP relay needed. The dashboard, docs, and blog live at **<https://flowmails.net>** — sign up there to create an account and bind your custom domain before this worker is deployed against it.

## Quick start

```bash
pnpm install
pnpm dev          # wrangler dev — local miniflare against the dev bindings in wrangler-dev.toml
pnpm build        # bundles src/index.js → dist/worker-${version}.js + drops a copy for apps/web
pnpm test         # vitest (workers pool)
pnpm lint         # eslint .
```

## Repository layout

```
.
├── src/                      # 40 ESM JavaScript files (plain JS, no TypeScript)
│   ├── index.js              # entry: { fetch, email, scheduled } handlers
│   ├── api/                  # Hono route registrations (side-effect imports)
│   ├── service/              # env-binding boundary, business logic
│   ├── entity/               # drizzle-orm sqliteTable definitions
│   ├── dao/                  # query helpers
│   ├── utils/                # pure helpers
│   ├── hono/                 # Hono app + middleware
│   ├── i18n/                 # localized strings (en, zh)
│   ├── template/             # email body renderers
│   └── const/                # constants + KV key prefixes
├── test/                     # vitest specs
├── packages/
│   └── emailworker-types/    # workspace package — wire-contract types (consumed by apps/web)
├── build.js                  # esbuild bundler + cross-project copy step
├── wrangler.toml             # production template (bindings commented out — set per-account via REST)
├── wrangler-dev.toml         # local miniflare bindings (flowmails-dev worker name)
├── vitest.config.js
├── eslint.config.js
└── r2-utils.js               # Node-side S3 SDK wrapper, not part of the worker bundle
```

## How the worker integrates with the platform

The Flowmails platform web app (`flowmails-cf` monorepo, `apps/web`) imports this worker's bundle via Vite's `?raw` query:

```ts
// apps/web/app/server/integrations/cloudflare-worker-service.ts
import workerBundle from "../email-worker/worker.js?raw";
import versionTxt from "../email-worker/version.txt?raw";
```

`build.js` writes both files into `apps/web/app/server/email-worker/` (a path that exists in the consuming monorepo). The bundle is inlined as a string into the web worker's SSR bundle, then uploaded per-account via Cloudflare's REST API when a user onboards or re-deploys.

## Bindings (per Cloudflare account)

| Binding | Type | Source |
|---------|------|--------|
| `db` | D1 (`flowmails-db`) | Created by `cloudflare-worker-service.ts#deployWorker` |
| `kv` | KV (`flowmails-kv`) | Same |
| `r2` | R2 (`flowmails-bucket`) | Same |
| `EMAIL` | send_email | Pre-existing on account |
| `VERSION` | plain_text | Stamped at deploy time from `version.txt` |
| `PLATFORM_INGEST_URL` | plain_text | Absolute URL of the platform's `/api/events/ingest` door; stamped by `deployWorker` / `redeployWorker` (1.6.0+) |
| `JWT_SECRET` | secret_text | Per-account bearer; literal-string compared in `service/security.js` |

## Auth model

The worker authenticates incoming calls via `Authorization: Bearer ${JWT_SECRET}`. `JWT_SECRET` is a per-account bearer token (UUID), not a signed JWT — `service/security.js#verifyToken` does a literal-string compare. Treat it as a bearer secret.

The platform side encodes/decodes the secret through `apps/web/app/server/integrations/token-codec.ts`.

## Database

Drizzle schema in `src/entity/`. Four tables: `email`, `attachments`, `star`, `unreadcount`. Migrations are hand-maintained in `src/service/bootstrap-service.js#VERSION_MIGRATION` (latest-first array); bumping `env.VERSION` triggers pending migrations on `/api/bootstrap`.

The `unreadcount` cache is maintained in `src/service/unreadcount-service.js` and read by `email-service.countUnreadByDomain*`. Inbound receives are the only writers.

## Email routing

Catch-all routing is configured in Cloudflare Email Routing (not in this worker). When a message lands at `<localpart>@<user-domain>`, Cloudflare invokes the `email` handler in `src/index.js`, which:

1. Decides the recipient against the KV route table via `routeService.decide` **before** parsing — a miss rejects with `550 5.1.1`.
2. Parses the MIME message via `postal-mime`.
3. Persists the row via `emailService.save` (which also threads `Message-ID` / `In-Reply-To` into `threadId` / `threadPosition`).
4. Stores attachments via `attService.insertBatch`.
5. Bumps the `unreadcount` cache.
6. Reports the accepted message to the platform's event log (1.6.0+, see below).
7. Runs the asynchronous Rspamd check; a reject moves the row into `junk_email`.

## Event ingest (1.6.0)

After `emailService.completeReceive` commits the row, `src/service/event-ingest-service.js` POSTs to the platform's `/api/events/ingest` door with the per-account `JWT_SECRET` as the bearer:

```json
{
  "messageId": "<...>",
  "event": "inbound.received",
  "version": 2,
  "recipient": "support@example.com",
  "sender": "sender@example.com",
  "subject": "Your invoice is ready"
}
```

The payload carries **routing facts plus the subject line**; the body and attachments stay in this worker's D1/R2. The platform rejects any other field rather than trimming it, and its `message_event` table has no body or attachment column.

- The call is scheduled with `ctx.waitUntil`, so the SMTP path never waits on the platform. It runs in parallel with the Rspamd check.
- `PLATFORM_INGEST_URL` is stamped by the platform's `deployWorker` / `redeployWorker`. Unset, empty, or relative → the report is skipped (and logged once per isolate).
- A message without a `Message-ID` is not reported: the platform log and its content-fetch path are both keyed on it.
- An invalid `recipient`, an over-long `messageId`, or a malformed `From:` skips/omits only what cannot be represented; a subject over 998 characters is dropped while the event still reports.
- Best-effort: 5s timeout, two attempts, retry only on 5xx / 408 / 429 with a 250ms gap. A failure is logged and dropped — the message is already in D1. The platform's ingest is idempotent on `(user_id, message_id, event_type)`, so a retry after a timeout is safe.
- A message later classified as junk keeps its event; its row moves to `junk_email`, so a content fetch may 404 until it is restored.

## Wire contract

The 16+ endpoint shapes (request/response) are typed in `packages/emailworker-types/`. The platform's `email-worker-proxy.ts` derives every helper signature from these types, adding a platform-only `domainId` field.

## License

MIT — see [LICENSE](./LICENSE).