import app from '../hono/hono';
import result from '../utils/result';
import attService from '../service/att-service';
import emailService from '../service/email-service';

app.get('/email/list', async (c) => {
  // `to` is repeated when the web proxy narrows by localparts
  // (`?to=support@x&to=aa@x`). `c.req.query()` collapses repeats to
  // the last value, so pull it via `queries()` and merge into the
  // params bag the service destructures.
  const params = c.req.query();
  const to = c.req.queries('to');
  const data = await emailService.list(c, { ...params, to });
  return c.json(result.ok(data));
});

app.get('/email/search', async (c) => {
  // Substring filter across subject / from / to / body. No FTS5 —
  // the worker's `search()` service applies a SQL `LIKE %q%` after
  // the indexed access path. `to` is repeated for the localpart
  // multi-select same as `/email/list`. The proxy is responsible
  // for trimming `q` to a minimum 2 chars so a stray keystroke
  // doesn't issue a full-table scan.
  const params = c.req.query();
  const to = c.req.queries('to');
  const data = await emailService.search(c, { ...params, to });
  return c.json(result.ok(data));
});

app.get('/email/thread', async (c) => {
  // Conversation thread resolver. The web client passes the email
  // id of the message the user just clicked; we walk the inReplyTo /
  // references chain and return the rest of the conversation in
  // chronological order so the reading pane can render the whole
  // conversation. The current row is excluded (the caller already
  // has it from the list loader); the response is a paginated
  // preview page with `hasMore` / `nextBeforeId` for "View earlier
  // messages" pagination. See `emailService.thread` for the
  // truncation + batch-hydrate implementation.
  const data = await emailService.thread(c, c.req.query());
  return c.json(result.ok(data));
});

app.get('/email/get', async (c) => {
  // Single-row full-body fetch. Used by the ReadingPane to expand
  // a prior message in a conversation chain after the thread
  // preview page has already shipped. The `domain` query param
  // is the IDOR check (must match the row's `toDomain` /
  // `fromDomain` virtual column); the platform proxy passes the
  // domain bound to the worker it's dispatching to, so a
  // mismatched row is treated as not-found.
  const data = await emailService.getOne(c, c.req.query());
  return c.json(result.ok(data));
});

app.get('/email/latest', async (c) => {
  const list = await emailService.latest(c, c.req.query());
  return c.json(result.ok(list));
});

app.delete('/email/delete', async (c) => {
  await emailService.delete(c, c.req.query());
  return c.json(result.ok());
});

app.delete('/email/batchDelete', async (c) => {
  // Bulk real-delete by id list (1.1.6+ — used to be a soft
  // `is_del = 1` update; now it issues a real `DELETE FROM email`
  // with cascade to attachments + stars + the unread-count cache).
  // The web side's emailbox multi-select posts `?emailIds=1,2,3`.
  // Callers should prefer this over the single-id `/email/delete`
  // when more than one row is involved.
  await emailService.batchDelete(c, c.req.query());
  return c.json(result.ok());
});

app.get('/email/attList', async (c) => {
  const attList = await attService.list(c, c.req.query());
  return c.json(result.ok(attList));
});

app.post('/email/send', async (c) => {
  const data = await emailService.dispatchOutbound(c, await c.req.json());
  return c.json(result.ok(data));
});

app.put('/email/read', async (c) => {
  await emailService.read(c, await c.req.json());
  return c.json(result.ok());
});

// Bulk "Mark all as read" for a mailbox **scope** rather than an id
// list: `PUT /api/email/readAll` with `{ domain, to? }`, where `to`
// is the same repeated localpart field `/email/list` accepts (the
// web proxy composes full `local@domain` addresses into it; the
// service strips the domain back off before matching `to_local`).
// Omitting `to` means every mailbox on the domain. Resolves to
// `{ updated: <row count> }`.
//
// Added in 1.4.2 — a worker older than this answers a plain 404 on
// this path (Hono has no such route), which the platform proxy maps
// to an upgrade hint rather than a generic gateway error.
app.put('/email/readAll', async (c) => {
  const data = await emailService.readAll(c, await c.req.json());
  return c.json(result.ok(data));
});

// Inverse of `/email/read`: flips `unread = 1` for the given ids and
// bumps the per-mailbox counter (order matters — see `markUnread` for
// the invariant). Used by the emailbox "Mark as unread" affordance;
// also the bulk-mark-unread path on the multi-select toolbar.
app.put('/email/unread', async (c) => {
  await emailService.markUnread(c, await c.req.json());
  return c.json(result.ok());
});

app.post('/email/countUnread', async (c) => {
  const { domains } = await c.req.json();
  const data = await emailService.countUnreadByDomains(c, domains);
  return c.json(result.ok(data));
});

app.get('/email/countUnreadByDomain', async (c) => {
  const { domain } = c.req.query();
  const data = await emailService.countUnreadByDomain(c, domain);
  return c.json(result.ok(data));
});
