import { and, eq, inArray } from 'drizzle-orm';
import orm from '../entity/orm';

/**
 * Query helpers shared by the list / search / attachment paths.
 *
 * Both exports exist because of hard D1 limits that are invisible in
 * the query builders and only bite once a mailbox gets big enough to
 * page through.
 */

/**
 * D1's `SQLITE_MAX_VARIABLE_NUMBER` is 100. Every bind placeholder
 * counts, so `inArray(col, ids)` with 100 ids already exceeds it —
 * and it fails as a 500, not as an empty page.
 *
 * List pages are capped at `MAX_PAGE_SIZE` (100), so a full page of
 * attachment / star lookups by id would blow the ceiling exactly at
 * the largest page the pager can request. Chunking keeps each
 * statement well under the limit at the cost of a few extra
 * round-trips; the per-chunk `eq(type, 'att')` filter is re-applied
 * to each chunk so the merged result is identical to one wide query.
 *
 * 50 leaves headroom for the sibling `type` predicate (1) and any
 * future filter added to the same statement.
 */
export const D1_MAX_VARIABLES = 100;
const IN_CHUNK_SIZE = 50;

/**
 * Split an array into chunks of at most `size` entries.
 *
 * @param {unknown[]} items
 * @param {number} [size]
 * @returns {unknown[][]} one or more chunks; `[]` input yields `[]`
 */
export function chunk(items, size = IN_CHUNK_SIZE) {
	if (!Array.isArray(items) || items.length === 0) return [];
	const out = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/**
 * Normalise the repeated `to=` query param into bare local parts.
 *
 * The web proxy composes **full** addresses into `to` (`?to=support@x`
 * — see `listMails` in `apps/web/app/server/integrations/email-worker-proxy.ts`),
 * but the `to_local` / `from_local` virtual columns only store the
 * part before the `@`. A query filter compares against those columns,
 * so the domain has to come off first or the `IN (...)` never matches
 * and the filter silently returns nothing.
 *
 * `readAll` has always stripped the domain here; `list` / `search` /
 * `listJunk` did not, which is why the emailbox's local-part picker
 * never narrowed anything.
 *
 * @param {unknown} to the raw `to` param (array from `queries('to')`, or a bare string)
 * @returns {string[]} the local parts, de-duplicated, in first-seen order
 */
export function toLocalParts(to) {
	let raw;
	if (Array.isArray(to)) {
		raw = to;
	} else if (to === undefined || to === null) {
		raw = [];
	} else {
		raw = [to];
	}

	const out = [];
	const seen = new Set();
	for (const entry of raw) {
		const local = String(entry ?? '')
			.trim()
			.split('@')[0]
			.trim();
		if (!local || seen.has(local)) continue;
		seen.add(local);
		out.push(local);
	}
	return out;
}

/**
 * Fetch rows of `table` matching a page of email ids, without exceeding
 * D1's bind-variable ceiling.
 *
 * The shared chunk-and-flat half of both page lookups: attachments and
 * stars are the same shape (a table, a `emailId IN (…)` predicate) and
 * differ only in the extra `type = 'att'` filter attachments carry.
 * Writing them as one function is what keeps the chunk size in a single
 * place — if the two had drifted apart, one of them would start 500ing
 * at exactly the largest page the pager can request.
 *
 * @param {any} c worker context (for the D1 binding)
 * @param {any} table the Drizzle table to select from
 * @param {number[]} emailIds ids from one list page
 * @param {any[]} [extra] additional predicates, e.g. `eq(attach.type, 'att')`
 * @returns {Promise<object[]>} every matching row across all chunks
 */
async function selectByEmailIds(c, table, emailIds, extra = []) {
	if (!Array.isArray(emailIds) || emailIds.length === 0) return [];
	const batches = await Promise.all(
		chunk(emailIds).map((ids) =>
			orm(c.env)
				.select()
				.from(table)
				.where(and(inArray(table.emailId, ids), ...extra))
				.all(),
		),
	);
	return batches.flat();
}

/**
 * Attachment rows for a page of emails (`type = 'att'` only — inline
 * `cid:` images are filtered out so the emailbox list doesn't
 * double-count them).
 *
 * @param {any} c worker context
 * @param {import('../entity/att').attach} attach the `attach` table
 * @param {number[]} emailIds ids from one list page
 * @returns {Promise<object[]>}
 */
export function selectAttsByEmailIds(c, attach, emailIds) {
	return selectByEmailIds(c, attach, emailIds, [eq(attach.type, 'att')]);
}

/**
 * Star rows for a page of emails, chunked for the same D1 bind-variable
 * ceiling as {@link selectAttsByEmailIds}.
 *
 * @param {any} c worker context
 * @param {import('../entity/star').star} star the `star` table
 * @param {number[]} emailIds ids from one list page
 * @returns {Promise<object[]>}
 */
export function selectStarsByEmailIds(c, star, emailIds) {
	return selectByEmailIds(c, star, emailIds);
}