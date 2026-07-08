# @flowmails/emailworker-types

Wire-contract types for the [Flowmails](https://flowmails.net) receive-worker HTTP API. These types describe the request/response shapes that `@flowmails/email-worker` accepts over `/api/*` and returns to callers.

This package is **type-only**: the worker itself is plain ESM JavaScript with no compile-time type surface. The shared types are the only place the wire contract is documented.

## Consumers

The Flowmails platform consumes these types through a pnpm workspace reference:

```jsonc
// packages/shared/package.json (in the flowmails-cf monorepo)
{
	"dependencies": {
		"@flowmails/emailworker-types": "workspace:*"
	}
}
```

The SDK package re-exports only the cross-cutting wire DTOs (`EmailSendResult`, `EmailSendAttachment`, `EmailStatus`, `EmailType`, `EmailUnreadFlag`). It does **not** re-export proxy-side `*Args` types — those carry a platform-only `domainId` field that third-party SDK callers don't have.

## Layout

```
src/
├── envelope.ts     # generic envelope (EmailWorkerResult<T>, EmailWorkerError, etc.)
├── email.ts        # mailbox endpoints (list, thread, get, send, read, delete, star, …)
├── ai-agent.ts     # /api/agent/chat + /api/agent/tools/call
├── analysis.ts     # /api/analysis/echarts
├── bootstrap.ts    # /api/bootstrap
└── index.ts        # barrel
```

## Conventions

- `Request` suffix for inputs.
- `Response` suffix for outputs.
- JSDoc on every exported type or interface documenting the wire-level contract (since the worker is JS with no compile-time types, the JSDoc is the only place the contract lives).
- All numeric status codes match the worker's source — `EmailStatus` numeric literals mirror `apps/email-worker/src/entity/email.js#EmailConst.status`.

## Versioning

This package's version is cut from the same source of truth as `@flowmails/email-worker#version` in `package.json`. Bumping the worker version requires bumping this package too — they share the deploy artifact.

## License

MIT — see [LICENSE](../../LICENSE).