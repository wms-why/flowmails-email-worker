import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler-dev.toml' },
				// `wrangler-dev.toml` is authored for `wrangler dev`, where
				// `[[d1_databases]]` / `[[kv_namespaces]]` / `[[r2_buckets]]`
				// are objects keyed by binding name. The vitest pool's schema
				// wants the binding *names* as plain arrays, so declare them
				// here as well — these win over the wrangler-derived shape.
				//
				// `bindings` supplies the `env.VERSION` / `env.JWT_SECRET` that
				// `bootstrap-service.js` and `service/security.js` read, so the
				// API specs can authenticate with `Bearer ${env.JWT_SECRET}`.
				miniflare: {
					d1Databases: ['db'],
					kvNamespaces: ['kv'],
					r2Buckets: ['r2'],
					sendEmail: true,
					bindings: {
						VERSION: '1.4.0',
						JWT_SECRET: 'local-dev-jwt-secret',
						// The event-ingest spec intercepts both URLs with
						// `fetchMock`; the real endpoints are never called.
						PLATFORM_INGEST_URL: 'https://platform.test/api/events/ingest',
						RSPAMD_CHECK_URL: 'https://rspamd.test/api/check',
					},
				},
			},
		},
	},
});
