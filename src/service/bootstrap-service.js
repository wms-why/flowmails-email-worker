import KvConst from '../const/kv-const';

const bootstrap = {
	async bootstrap(c) {
		await this.migrate(c);

		await c.env.kv.put(KvConst.LAST_VERSION, c.env.VERSION);
	},

	async migrate(c) {
		const currentVersion = c.env.VERSION;

		if (!currentVersion) {
			// 无版本号，跳过迁移
			console.error('env has not VERSION');

			return;
		}
		const lastVersion = (await c.env.kv.get(KvConst.LAST_VERSION)) || '0.0.0';

		if (compareVersion(currentVersion, lastVersion) <= 0) {
			// 无需迁移
			return;
		}

		for (const migration of VERSION_MIGRATION.reverse()) {
			if (compareVersion(migration.version, lastVersion) > 0 && compareVersion(migration.version, currentVersion) <= 0) {
				// 执行迁移
				await migration.exec(c);
			}
		}
	},
};

/**
 * 比较版本号大小
 * @param {string} v1
 * @param {string} v2
 * @returns
 */
function compareVersion(v1, v2) {
	const v1Parts = v1.split('.').map(Number);
	const v2Parts = v2.split('.').map(Number);

	for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
		const part1 = v1Parts[i] || 0;
		const part2 = v2Parts[i] || 0;

		if (part1 > part2) return 1;
		if (part1 < part2) return -1;
	}
	return 0;
}

/**
 * 版本迁移列表
 * 顺序为从高到低
 * 每次新增版本迁移时，添加到数组头部
 *
 * 注意：必须**严格按版本号降序**排列 — `.reverse()` 之后会以
 * 低→高顺序执行。如果一条 migration 引用了另一条 migration 创建的
 * 表/索引（例如 1.1.5 的 backfill `SELECT FROM email`），被引用
 * 的 migration 必须排在**更低**的位置（更靠数组尾部）。1.1.5 曾被
 * 误加到数组末尾，导致 `.reverse()` 之后 1.1.5 先于 1.0.1 执行，
 * 触发 `no such table: email` 错误。
 * @type {Array<{version: string, exec: (c: any) => Promise<void>}>}
 */
const VERSION_MIGRATION = [
	{
		// 1.2.0 — add the `junk_email` sink for inbound messages
		// the Rspamd check classifies as spam or phishing. Receive
		// flow saves the row to `email` as usual, then runs the
		// Rspamd classifier in `ctx.waitUntil` and, on
		// `action === "reject"`, deletes the row from `email` and
		// inserts it here with the spam fields stamped on. Restore
		// goes the other way.
		//
		// Schema mirrors `email` minus the conversation-thread
		// columns (junk is rarely threaded) plus the Rspamd
		// scoring fields. The address-part split expressions are
		// the same shape used in `entity/email.js` and
		// `entity/junk-email.js` — Drizzle reads the same
		// expression off the entity when generating queries, so a
		// drift between the three would corrupt the index entries.
		version: '1.2.0',
		exec: async (c) => {
			await c.env.db
				.prepare(
					`
			CREATE TABLE IF NOT EXISTS junk_email (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				from_email TEXT NOT NULL,
				from_local TEXT GENERATED ALWAYS AS (
					CASE WHEN instr(from_email, '@') > 0
					     THEN substr(from_email, 1, instr(from_email, '@') - 1)
					     ELSE from_email END
				) VIRTUAL,
				from_domain TEXT GENERATED ALWAYS AS (
					CASE WHEN instr(from_email, '@') > 0
					     THEN substr(from_email, instr(from_email, '@') + 1)
					     ELSE '' END
				) VIRTUAL,
				from_name TEXT,
				to_email TEXT NOT NULL DEFAULT '',
				to_local TEXT GENERATED ALWAYS AS (
					CASE WHEN instr(to_email, '@') > 0
					     THEN substr(to_email, 1, instr(to_email, '@') - 1)
					     ELSE to_email END
				) VIRTUAL,
				to_domain TEXT GENERATED ALWAYS AS (
					CASE WHEN instr(to_email, '@') > 0
					     THEN substr(to_email, instr(to_email, '@') + 1)
					     ELSE '' END
				) VIRTUAL,
				to_name TEXT,
				subject TEXT,
				text TEXT,
				content TEXT,
				cc TEXT DEFAULT '[]',
				bcc TEXT DEFAULT '[]',
				recipient TEXT,
				message_id TEXT DEFAULT '',
				in_reply_to TEXT DEFAULT '',
				type TEXT DEFAULT 'receive' NOT NULL,
				status INTEGER DEFAULT 0 NOT NULL,
				unread INTEGER DEFAULT 1 NOT NULL,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
				spam_score REAL NOT NULL,
				spam_action TEXT NOT NULL,
				spam_required_score REAL NOT NULL,
				spam_symbols TEXT,
				spam_checked_at INTEGER NOT NULL
			)
		`,
				)
				.run();

			// Junk list / count: same partial-index shape as
			// `idx_email_inbox`. The leading column is the
			// indexed `to_domain` virtual column; `id DESC`
			// matches the worker's `ORDER BY id DESC LIMIT ?`
			// list query without a sort step.
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_junk_email_to_domain
						ON junk_email(to_domain, id DESC)`,
				)
				.run();

			// Restore path looks the junk row up by `message_id`
			// when re-attaching to a conversation chain on the
			// live table (rare, but cheap to keep covered).
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_junk_email_message_id
						ON junk_email(message_id)`,
				)
				.run();

			// Add `junk_email_id` to `attachments` so junk rows
			// can carry their attachments through the
			// `email` → `junk_email` swap without a separate
			// `junk_attachments` table. `email_id` stays NOT
			// NULL — when an attachment is moved into the
			// junk state we keep `email_id` pointing at the
			// (now-deleted) original email row and stamp the
			// `junk_email_id` instead; on restore we rewrite
			// `email_id` to the new live row. `deleteJunk`
			// cascades by `junk_email_id`, so the row only
			// leaves the table when the user actually purges
			// the junk row.
			await c.env.db
				.prepare(
					`ALTER TABLE attachments ADD COLUMN junk_email_id INTEGER`,
				)
				.run();

			// The junk-state attachment lookup is the only
			// non-trivial read path on `junk_email_id` (used
			// by the cascade-delete helper). Cheap to keep
			// covered.
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_attachments_junk_email_id
						ON attachments(junk_email_id)
						WHERE junk_email_id IS NOT NULL`,
				)
				.run();
		},
	},
	{
		// 1.1.9 — drop the `email.thread_position` column. The
		// field was write-only — the worker stamped a depth number
		// at insert time, but no query (not the inbox list, not
		// the `thread()` chain scan, not any UI surface) ever read
		// it back. Chain order is served by `email.id` (the worker
		// orders by `id DESC` and the ReadingPane reverses for
		// display). The schema is now strictly: `threadId` is the
		// chain anchor, `id` is the position.
		version: '1.1.9',
		exec: async (c) => {
			// No index references `thread_position` (`idx_email_thread`
			// is on `(thread_id, id) WHERE thread_id IS NOT NULL`
			// from 1.1.6), so the DROP is a single statement.
			await c.env.db
				.prepare(`ALTER TABLE email DROP COLUMN thread_position`)
				.run();
		},
	},
	{
		// 1.1.6 — drop the `email.is_del` column. Deletes are now a
		// real `DELETE FROM email` (with cascade to `attachments`
		// / `star` / `unreadcount`) — see `email-service.batchDelete`.
		//
		// Three things have to land in order:
		//   1. Drop every index whose partial predicate references
		//      `is_del`. SQLite refuses `ALTER TABLE ... DROP COLUMN`
		//      while an index or view still touches the column.
		//   2. Recreate the same indexes with the `is_del = 0`
		//      predicate removed. The `type = 'receive' | 'send'`
		//      and `thread_id IS NOT NULL` predicates stay — those
		//      still cut the index down to the rows the matching
		//      query path actually wants.
		//   3. `ALTER TABLE email DROP COLUMN is_del`. After this
		//      point every code path that used to filter on
		//      `is_del = 0` is a plain equality / range scan on
		//      the remaining columns, and the row that the
		//      old "soft delete" set would have held is gone —
		//      any legacy `is_del = 1` row is dropped here too
		//      (the new code never sets `is_del`, so the only
		//      rows in that state are pre-1.1.6 trash that we no
		//      longer surface in any UI).
		version: '1.1.6',
		exec: async (c) => {
			// Step 1 — drop the partial indexes that reference
			// `is_del`. `DROP INDEX IF EXISTS` is a no-op on fresh
			// installs where 1.0.1 / 1.1.5 already produced the
			// modern shape (we keep the DROP for the upgrade case
			// where these indexes exist with the old predicate).
			await c.env.db
				.prepare(`DROP INDEX IF EXISTS idx_email_inbox`)
				.run();
			await c.env.db
				.prepare(`DROP INDEX IF EXISTS idx_email_inbox_local`)
				.run();
			await c.env.db
				.prepare(`DROP INDEX IF EXISTS idx_email_sentbox`)
				.run();
			await c.env.db
				.prepare(`DROP INDEX IF EXISTS idx_email_sentbox_local`)
				.run();
			await c.env.db
				.prepare(`DROP INDEX IF EXISTS idx_email_thread`)
				.run();

			// Step 2 — recreate without the `is_del = 0`
			// predicate. The column list matches 1.0.1 byte-for-byte
			// (only the WHERE clause shrinks). The address-part
			// split is the same expression used in `entity/email.js`
			// so the index entries line up with the equality
			// filters the queries emit.
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_inbox
						ON email(to_domain, id DESC)
						WHERE type = 'receive'`,
				)
				.run();
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_inbox_local
						ON email(to_domain, to_local, id DESC)
						WHERE type = 'receive'`,
				)
				.run();
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_sentbox
						ON email(from_domain, id DESC)
						WHERE type = 'send'`,
				)
				.run();
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_sentbox_local
						ON email(from_domain, from_local, id DESC)
						WHERE type = 'send'`,
				)
				.run();
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_thread
						ON email(thread_id, id)
						WHERE thread_id IS NOT NULL`,
				)
				.run();

			// Step 3 — drop the column. `ALTER TABLE ... DROP
			// COLUMN` is supported on every D1 SQLite build
			// (≥ 3.35.0). The earlier DROP INDEX calls guarantee
			// the column isn't referenced anywhere by the time we
			// get here.
			await c.env.db
				.prepare(`ALTER TABLE email DROP COLUMN is_del`)
				.run();
		},
	},
	{
		// 1.1.5 — replace the `countUnreadByDomain*` `COUNT(*)` over
		// `email` with a maintained per-mailbox `unreadcount` row.
		//
		// Schema:
		//   * `to_email` is the natural primary key — a mailbox
		//     address. A row exists for every recipient that has at
		//     least one outstanding unread email.
		//   * `to_domain` mirrors the virtual-column expression in
		//     `entity/email.js` so the read-side filter
		//     (`to_domain = ?`) is an indexed equality, not a
		//     `LIKE '%@…'` suffix scan.
		//   * `idx_unreadcount_domain` is a *partial* index keyed on
		//     `(to_domain)` with predicate `count > 0`, so the index
		//     is only as big as the set of mailboxes that currently
		//     have outstanding mail — almost always a tiny handful
		//     per account.
		//
		// Backfill:
		//   For databases that existed before this migration, the
		//   `email` table already carries the source-of-truth count;
		//   the `INSERT … SELECT … GROUP BY` rebuilds `unreadcount`
		//   from a single grouped scan and is a no-op on fresh DBs
		//     where the `email` table is empty.
		version: '1.1.5',
		exec: async (c) => {
			await c.env.db
				.prepare(
					`
				CREATE TABLE IF NOT EXISTS unreadcount (
					to_email TEXT PRIMARY KEY NOT NULL,
					to_domain TEXT GENERATED ALWAYS AS (
						CASE WHEN instr(to_email, '@') > 0
						     THEN substr(to_email, instr(to_email, '@') + 1)
						     ELSE '' END
					) VIRTUAL,
					count INTEGER NOT NULL DEFAULT 0,
					update_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
				)
			`,
				)
				.run();

			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_unreadcount_domain
						ON unreadcount(to_domain)
						WHERE count > 0`,
				)
				.run();

			// Seed the counter from the live `email` rows that were
			// outstanding at the moment of upgrade. The `WHERE`
			// predicate matches the pre-rewrite
			// `countUnreadByDomain*` filter exactly, so a domain's
			// pre-migration badge value equals its post-migration
			// badge value with no API-visible change.
			await c.env.db
				.prepare(
					`INSERT INTO unreadcount (to_email, count, update_time)
					 SELECT to_email, COUNT(*) AS unread_total, CURRENT_TIMESTAMP
					 FROM email
					 WHERE unread = 1 AND is_del = 0
					 GROUP BY to_email
					 ON CONFLICT(to_email) DO UPDATE SET
						count = excluded.count,
						update_time = CURRENT_TIMESTAMP`,
				)
				.run();
		},
	},
	{
		// 1.0.1 — initial schema (canonical, rewritten for the
		// address-part + thread_id redesign). Every query path is
		// backed by a partial B-tree index that matches the equality
		// / range shape the code actually uses:
		//
		//   * `idx_email_inbox` / `idx_email_inbox_local` cover
		//     `list()` / `latest()` receive + localpart filter.
		//   * `idx_email_sentbox` / `idx_email_sentbox_local` cover
		//     the same shapes for sent mail.
		//   * `idx_email_thread` makes `thread()` a single indexed
		//     range scan over chain members (replaces the old
		//     `messageId IN ∪ inReplyTo IN` two-arm scan + json_each
		//     fallback).
		//   * `idx_email_status_saving` is what the scheduled
		//     `completeReceiveAll` job sweeps over.
		//   * `idx_email_message_id` / `idx_email_in_reply_to` stay
		//     for the upstream-`messageId` lookups that
		//     `updateEmailStatus` (CF send webhook) needs.
		//
		// NOTE — `countUnreadByDomain*` used to read straight off
		// the email table with a `LIKE '%@domain'` suffix scan and
		// is intentionally not covered here; it now goes through
		// the maintained `unreadcount` table (see the 1.1.5
		// migration). `batchDelete` is id-only — it never ran
		// LIKE — so it also doesn't need a `subject` / `from_name`
		// index.
		//
		// `is_del` was the soft-delete tombstone. It lives in
		// 1.0.1's CREATE TABLE only so the table is well-formed
		// for a 1.0.1 → 1.1.5 upgrade path that needs the
		// `unreadcount` backfill to read `is_del = 0`. The 1.1.6
		// migration drops the column and rebuilds the partial
		// indexes against the now-permanent "live" set.
		version: '1.0.1',
		exec: async (c) => {
			// The split / domain expressions here MUST match the
			// ones in `entity/email.js` byte-for-byte; Drizzle
			// reads the same expression off the entity when
			// generating queries, and a drift between the two
			// would corrupt the index entries.
			await c.env.db
				.prepare(
					`
			CREATE TABLE IF NOT EXISTS email (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				from_email TEXT NOT NULL,
				from_local TEXT GENERATED ALWAYS AS (
					CASE WHEN instr(from_email, '@') > 0
					     THEN substr(from_email, 1, instr(from_email, '@') - 1)
					     ELSE from_email END
				) VIRTUAL,
				from_domain TEXT GENERATED ALWAYS AS (
					CASE WHEN instr(from_email, '@') > 0
					     THEN substr(from_email, instr(from_email, '@') + 1)
					     ELSE '' END
				) VIRTUAL,
				from_name TEXT,
				to_email TEXT NOT NULL DEFAULT '',
				to_local TEXT GENERATED ALWAYS AS (
					CASE WHEN instr(to_email, '@') > 0
					     THEN substr(to_email, 1, instr(to_email, '@') - 1)
					     ELSE to_email END
				) VIRTUAL,
				to_domain TEXT GENERATED ALWAYS AS (
					CASE WHEN instr(to_email, '@') > 0
					     THEN substr(to_email, instr(to_email, '@') + 1)
					     ELSE '' END
				) VIRTUAL,
				to_name TEXT,
				subject TEXT,
				text TEXT,
				content TEXT,
				cc TEXT DEFAULT '[]',
				bcc TEXT DEFAULT '[]',
				recipient TEXT,
				message_id TEXT DEFAULT '',
				in_reply_to TEXT DEFAULT '',
				thread_id TEXT,
				thread_position INTEGER DEFAULT 0,
				send_feedback TEXT,
				type TEXT DEFAULT 'receive' NOT NULL,
				status INTEGER DEFAULT 0 NOT NULL,
				unread INTEGER DEFAULT 1 NOT NULL,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
				is_del INTEGER DEFAULT 0 NOT NULL
			)
		`,
				)
				.run();

			// Inbox: list() / latest() for received mail of a
			// domain, paginated by id desc. The leading column is
			// the indexed `to_domain`; the partial predicate keeps
			// the index small by excluding soft-deleted rows.
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_inbox
						ON email(to_domain, id DESC)
						WHERE is_del = 0 AND type = 'receive'`,
				)
				.run();

			// Inbox by localpart: covers the emailbox's
			// multi-select picker. `(to_domain, to_local, id)`
			// means a query that filters on a domain + a set of
			// localparts can range-scan within the domain prefix.
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_inbox_local
						ON email(to_domain, to_local, id DESC)
						WHERE is_del = 0 AND type = 'receive'`,
				)
				.run();

			// Sentbox: symmetric to inbox, anchored on
			// `from_domain` (the sender's own mailbox domain).
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_sentbox
						ON email(from_domain, id DESC)
						WHERE is_del = 0 AND type = 'send'`,
				)
				.run();

			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_sentbox_local
						ON email(from_domain, from_local, id DESC)
						WHERE is_del = 0 AND type = 'send'`,
				)
				.run();

			// Thread: `thread()` is now a single indexed range
			// scan over the chain. The leading column is
			// `thread_id`; `id` is the secondary so the result
			// comes back in chronological order without a sort.
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_thread
						ON email(thread_id, id)
						WHERE is_del = 0 AND thread_id IS NOT NULL`,
				)
				.run();

			// Scheduled job: `completeReceiveAll` sweeps every
			// row in `status = SAVING` once a day. Without an
			// index this is a full table scan; with the partial
			// index it's a small range scan over a handful of
			// rows that exist only while a receive is in flight.
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_status_saving
						ON email(status)
						WHERE status = 6`,
				)
				.run();

			// Upstream-side lookups: `updateEmailStatus` runs
			// when Cloudflare's send API reports a delivery
			// outcome keyed on the messageId we sent. Not on
			// any hot read path; cheap secondary index.
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_message_id
						ON email(message_id)`,
				)
				.run();
			await c.env.db
				.prepare(
					`CREATE INDEX IF NOT EXISTS idx_email_in_reply_to
						ON email(in_reply_to)`,
				)
				.run();

			// Create star / attachments tables unchanged.
			await c.env.db
				.prepare(
					`
			CREATE TABLE IF NOT EXISTS star (
				star_id INTEGER PRIMARY KEY AUTOINCREMENT,
				email_id INTEGER NOT NULL,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
			)
		`,
				)
				.run();

			await c.env.db
				.prepare(
					`
			CREATE TABLE IF NOT EXISTS attachments (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				email_id INTEGER NOT NULL,
				key TEXT NOT NULL,
				filename TEXT,
				mime_type TEXT,
				size INTEGER,
				disposition TEXT,
				related TEXT,
				content_id TEXT,
				encoding TEXT,
				status TEXT DEFAULT '0' NOT NULL,
				type TEXT DEFAULT 'att' NOT NULL,
				create_time TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
			)
		`,
				)
				.run();
		},
	},
];
export default bootstrap;
