# Contributing

## Repo roles

This repo is the per-account receive-worker for Flowmails. It is consumed by the [flowmails-cf](https://github.com/wms-why/flowmails-cf) monorepo as a `git submodule` at `apps/email-worker/`. The monorepo's `apps/web` reads the bundle through a Vite `?raw` import and uploads it to each user's Cloudflare account on deploy.

## Development workflow

The submodule lives inside the monorepo, so most day-to-day work happens from the monorepo root:

```bash
# Clone both repos in one shot
git clone --recurse-submodules https://github.com/wms-why/flowmails-cf.git

# Or, if you already cloned without --recurse-submodules:
git submodule update --init --recursive
```

To work on this worker:

```bash
cd apps/email-worker            # the submodule
# edit files
pnpm install
pnpm dev                        # local miniflare
pnpm build                      # bundles to dist/, drops a copy to apps/web
pnpm test                       # vitest
```

To push changes upstream:

```bash
cd apps/email-worker            # inside the submodule
git add .
git commit -m "..."
git push                        # pushes to https://github.com/wms-why/flowmails-email-worker
cd ../..
git add apps/email-worker       # update the monorepo's submodule ref
git commit -m "chore: bump email-worker submodule"
```

To pull the latest from upstream:

```bash
git submodule update --remote apps/email-worker
```

## Plain ESM JavaScript — no TypeScript syntax in `.js`

This package is `.js` end-to-end and esbuild's `build.js` does **not** strip type annotations. Do not introduce TS syntax into `.js` files. Things that look like JS but aren't:

- `sql<string>` — parsed as `sql < string`, throws `ReferenceError`.
- `as Foo` — parsed as a comparison.
- `<Foo>(x) => …` — parsed as JSX-ish or a comparison.
- `interface { … }`, `type X = …` — not valid JS.

If you need full TS, change the file's extension to `.ts` and teach `build.js` to load `.ts` via `esbuild`'s `loader: { '.ts': 'ts' }`. Don't sprinkle TS syntax into `.js`.

Before merging, run `node --check <file>` on every `.js` file you changed.

## Layer pattern

`api/*.js` (Hono route registration, side-effect) → `service/*.js` (env-binding boundary, business logic) → `entity/*.js` (drizzle schema) / `dao/*.js` (queries) / `utils/*.js` (pure helpers) / `i18n/`.

`hono/webs.js` is the only file that does side-effect imports of every `api/*` module; the entry `src/index.js` only imports `webs.js`.

## Migrations

Append to `src/service/bootstrap-service.js#VERSION_MIGRATION` (latest-first). The latest entry's `version` must be ≤ `env.VERSION` for the migration to fire on `/api/bootstrap`. After editing, bump `package.json#version` and the `wrangler-dev.toml#vars.VERSION` if applicable.

## Filenames with typos

`src/utils/date-uitil.js` and `src/utils/domain-uitls.js` keep their typos (renaming would break every call site).

## Tests

The stale Hello World test in `test/index.spec.js` was rewritten to a `/api/ok` smoke test. Add new specs there or in `test/<area>.spec.js`.

`vitest.config.js` points at `wrangler-dev.toml` (the previous `wrangler.jsonc` reference was a typo).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.