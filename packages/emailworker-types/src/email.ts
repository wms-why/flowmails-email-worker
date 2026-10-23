/**
 * Type definitions for the email-domain endpoints of the
 * `flowmails-receive-worker` HTTP API.
 *
 * These cover every `/api/email/*` route declared in
 * `apps/email-worker/src/api/email-api.js`, plus the supporting row
 * shapes returned by the worker's services. The platform web worker
 * uses these to type its `email-worker-proxy.ts` helpers and the
 * downstream loaders/actions that read the response.
 *
 * Conventions:
 * - Request types use the `Request` suffix; response types use `Response`.
 *   "Args" types are the trimmed input shape the proxy helpers accept
 *   (typically `{ domainId, ...rest }`); the platform's
 *   `domainId → { baseUrl, jwt, domainName }` resolution lives in the
 *   proxy itself and is not surfaced here.
 * - All ids are the worker's auto-increment row id (`email.id`); the
 *   platform's UUID-shaped `domain.id` is a separate concern.
 * - Optional fields are typed exactly as the worker treats them —
 *   nullable strings for empty subject/content, `0 | 1` for the
 *   flag columns, etc. Don't normalise the shape at this layer.
 */

import type {
  EmailWorkerHttpResponse,
  EmailWorkerPaginationParams,
} from "./envelope.ts";

// ---------------------------------------------------------------------------
// Shared row fragments.
// ---------------------------------------------------------------------------

/**
 * Email lifecycle status. The numeric value matches
 * `EmailConst.status` in `apps/email-worker/src/entity/email.js`.
 */
export type EmailStatus =
  /** Inbound delivery confirmed and attachments stored. */
  | 0 // RECEIVE
  /** Outbound accepted by the SMTP relay. */
  | 1 // SENT
  /** SMTP `delivered` event received. */
  | 2 // DELIVERED
  /** SMTP `bounced` event received. */
  | 3 // BOUNCED
  /** Recipient marked the message as spam. */
  | 4 // COMPLAINED
  /** SMTP `delayed` event received. */
  | 5 // DELAYED
  /** Row inserted but the inbound pipeline is still finishing. */
  | 6 // SAVING
  /** Sentinel — no message state recorded. */
  | 7 // NOONE
  /** Send attempt failed; see `sendFeedback` for the relay's error. */
  | 8; // FAILED

/** Unread flag. The worker uses `0` for read and `1` for unread. */
export type EmailUnreadFlag = 0 | 1;

/**
 * Mailbox direction. The worker stores every row in the same `email`
 * table and tags it with this column; queries that want "inbox" pick
 * `receive`, "sent" pick `send`.
 */
export type EmailType = "receive" | "send";

/**
 * Attachment row as it lives in the `attachments` table
 * (`apps/email-worker/src/entity/att.js`). The `emailId` / `key` /
 * `filename` / `mimeType` / `size` columns are the public surface; the
 * rest are server-side bookkeeping.
 *
 * The `list` / `thread` / `send` responses attach an extra `url` field
 * (a fully-qualified R2 hostname + `key`); see {@link AttachmentInList}.
 */
export type AttachmentRow = {
  /** Auto-increment row id. */
  id: number;
  /** Owning email row id. */
  emailId: number;
  /** R2 object key. The `flowmails-bucket` URL is `https://<r2Domain>/<key>`. */
  key: string;
  /** Display filename as it appeared in the MIME part. */
  filename: string | null;
  /** MIME type. */
  mimeType: string | null;
  /** Byte size of the stored object. */
  size: number | null;
  /**
   * Upload lifecycle. The worker writes `0` for "present in R2";
   * the scheduled cleanup flips it when the object is removed.
   */
  status: string;
  /**
   * `att` for normal attachments, `embed` for inline images the
   * receive flow lifted out of the HTML body.
   */
  type: string;
  /** Raw `Content-Disposition` header. */
  disposition: string | null;
  /** Internal-use; not surfaced in the public API. */
  related: string | null;
  /** Content-ID for `cid:` references in HTML; null for plain attachments. */
  contentId: string | null;
  /** MIME `Content-Transfer-Encoding` (e.g. `base64`). */
  encoding: string | null;
  /** SQL `CURRENT_TIMESTAMP`; string, not a number. */
  createTime: string;
};

/**
 * Attachment as it appears inside an email row's `attList` — the row
 * columns plus a derived `url` the worker composes by prefixing the
 * R2 custom hostname.
 */
export type AttachmentInList = AttachmentRow & {
  /**
   * Pre-signed download URL. The worker computes this from
   * `getR2Domain(toEmail|fromEmail)` (the R2 custom hostname bound
   * to the recipient's or sender's domain) plus `key`.
   */
  url: string;
};

// ---------------------------------------------------------------------------
// Email row shape.
//
// The worker returns slightly different projections depending on the
// endpoint:
//   - `list` / `thread`  → `EmailListRow` (full row + star + attachments)
//   - `latest`           → `EmailListRow` (no star; attachments always)
//   - `send`             → `EmailSendResult` (slimmer projection via
//                         `toEmailRowResult`)
// ---------------------------------------------------------------------------

/**
 * Full email row as returned by `list` / `thread` / `latest`. Mirrors
 * the Drizzle schema in `apps/email-worker/src/entity/email.js`,
 * with the additions the worker makes in JS:
 *   - `attList` (computed via `attService.selectByEmailIds`)
 *   - `isStar` (computed via `starService.selectByEmailIds`)
 *   - the auto-generated `fromLocal` / `fromDomain` / `toLocal` /
 *     `toDomain` virtual columns the worker exposes to the API.
 *
 * `text` / `content` are nullable because rows inserted by the
 * `/api/email/send` reply path can have either or both omitted.
 */
export type EmailListRow = {
  /** Auto-increment row id. Stable cursor for pagination. */
  id: number;

  // Sender addressing ----------------------------------------------------
  /** Full sender address, e.g. `"Alice <alice@example.com>"` → `alice@example.com`. */
  fromEmail: string;
  /** Local part of `fromEmail` (the part before `@`). Materialised virtual column. */
  fromLocal: string;
  /** Domain part of `fromEmail` (the part after `@`). Materialised virtual column. */
  fromDomain: string;
  /** Display name parsed from the `From:` header; nullable. */
  fromName: string | null;

  // Recipient addressing -------------------------------------------------
  /** Full recipient address; empty string for send rows with no recipient recorded. */
  toEmail: string;
  /** Local part of `toEmail`. */
  toLocal: string;
  /** Domain part of `toEmail`. */
  toDomain: string;
  /** Display name from the `To:` header; nullable. */
  toName: string | null;

  // Content --------------------------------------------------------------
  subject: string | null;
  /** Plain-text body. */
  text: string | null;
  /** HTML body. */
  content: string | null;

  // Multi-recipient metadata (JSON-encoded arrays) -----------------------
  /** JSON-serialised `Cc:` list. Always a string; default `'[]'`. */
  cc: string;
  /** JSON-serialised `Bcc:` list. Always a string; default `'[]'`. */
  bcc: string;
  /**
   * JSON-serialised recipient array. The shape is
   * `Array<{ address: string, name: string }>`. The worker stores it
   * as a string column for the multi-recipient case; the proxy leaves
   * it as-is and the web client decodes when it needs the array.
   */
  recipient: string | null;

  // Conversation threading ----------------------------------------------
  /** SMTP `Message-ID`; empty string when the sender stripped it. */
  messageId: string;
  /** SMTP `In-Reply-To`; empty string when not a reply. */
  inReplyTo: string;
  /**
   * Stable conversation anchor (the root email's `messageId`).
   * `null` for orphan rows with no `Message-ID` header — those are
   * unthreadable by design and never appear in a `thread` lookup.
   * The chain order within a thread is `email.id` (ascending),
   * which is what `thread()` orders by.
   */
  threadId: string | null;

  // Routing / state ------------------------------------------------------
  type: EmailType;
  status: EmailStatus;
  unread: EmailUnreadFlag;
  /** SQL `CURRENT_TIMESTAMP`; string, not a number. */
  createTime: string;
  /**
   * Relay-side error string for send rows whose `status === 8`
   * (FAILED). The worker writes the SMTP error message into
   * `email.send_feedback` at the moment the send fails; rows that
   * succeeded leave it null. Always `null` for receive rows.
   */
  sendFeedback: string | null;

  // Worker-computed fields -----------------------------------------------
  /** `1` if the row appears in the `star` table, else `0`. */
  isStar: 0 | 1;
  /**
   * Attachments whose `type = 'att'` belong to this email; the worker
   * filters out inline `cid:` images so the emailbox list doesn't
   * double-count them. The R2 URL is already baked into each entry's
   * `url` field.
   */
  attList: AttachmentInList[];
};

// ---------------------------------------------------------------------------
// /api/email/list
// ---------------------------------------------------------------------------

/**
 * Query parameters for `GET /api/email/list`.
 *
 * The platform web worker calls this endpoint for both the inbox
 * (`type: "receive"`) and the sent box (`type: "send"`). The receive
 * worker uses the virtual `to_domain` / `from_domain` columns as the
 * indexed access path, so callers must pass a bare domain name (no
 * `@`, no scheme).
 */
export type EmailListRequest = EmailWorkerPaginationParams & {
  /** Mailbox direction. Anything other than `"send"` is treated as `"receive"`. */
  type: EmailType;
  /**
   * Bare domain name, e.g. `"flowmails.app"`. The worker filters on
   * `to_domain = ?` (for `type: "receive"`) or `from_domain = ?` (for
   * `type: "send"`) so it must be the value the row was written with.
   */
  domain: string;
  /**
   * Optional localpart filter. The web proxy composes the full
   * recipient address from each entry (`"support"` + domain) and
   * repeats the `to=` query param per localpart, e.g.
   * `?to=support@x&to=sales@x`. The worker then filters on
   * `to_local IN (?, ?, …)` to stay inside the compound partial index.
   */
  to?: string[];
  /**
   * Send `"1"` to narrow the result to rows that carry a `star` row —
   * the Starred mailbox. Omitted (or any other value) returns the
   * unfiltered mailbox, with `isStar` set per row either way.
   *
   * Shipped in receive-worker 1.5.0; a 1.4.x worker ignores the param
   * and returns the unfiltered mailbox, which is why the Starred tab
   * narrowed on `isStar` in the browser before. The predicate rides
   * the same filter set as `to` / `domain`, so on a starred request
   * `total` is the **starred** count.
   */
  starred?: string;
};

/**
 * Response payload for `/api/email/list`. Both fields are present
 * even on empty results; `total` is the full filtered count, not the
 * page length.
 */
export type EmailListResponse = {
  /** Page of rows in descending `id` order. */
  list: EmailListRow[];
  /** Total rows matching the filter (ignoring `size`). */
  total: number;
};

/**
 * Proxy-side args for {@link listMails} / {@link listInbox} /
 * {@link listSendbox}. The `type` field is intentionally omitted —
 * the `receive` vs `send` distinction is pinned by the specific
 * helper the caller picks. The proxy adds the bare `domain` query
 * param itself (resolved from `domainId`).
 */
export type EmailListArgs = Omit<
  EmailListRequest,
  "to" | "domain" | "type" | "starred"
> & {
  domainId: string;
  /** Local parts (e.g. `["support", "sales"]`); the proxy composes `local@domain`. */
  localparts?: string[];
  /**
   * Narrow to starred rows. A boolean here rather than the wire type's
   * `"1"` string because this is the proxy-side call shape — only
   * `listStarred` sets it, and `listMails` renders it into the query
   * param. The param is omitted entirely when this is falsy, so a
   * receive-worker older than 1.5.0 sees an unchanged request.
   */
  starred?: boolean;
};

// ---------------------------------------------------------------------------
// /api/email/search (GET) — substring filter (no FTS5)
// ---------------------------------------------------------------------------

/**
 * Which fields `EmailSearchRequest.q` matches against. `body` searches
 * the plain-text and HTML columns; the others search the named address
 * column and `subject`. The worker uses a SQL `LIKE %q%` post-filter
 * applied after the indexed access path (`(to|from)_domain, id DESC`),
 * so the call is O(scanned_page), not a full table scan — fine for
 * personal mailboxes where the per-page window is bounded, and
 * explicit about scaling limits so the next iteration can move to
 * FTS5 (or a Rust extension) without changing the wire shape.
 */
export type EmailSearchField = "subject" | "from" | "to" | "body";

/**
 * Query parameters for `GET /api/email/search`. Same shape as
 * {@link EmailListRequest} plus a required `q` and an optional
 * `field` (default `"body"`, which searches subject + from + to +
 * text + content).
 */
export type EmailSearchRequest = EmailWorkerPaginationParams & {
  /** Mailbox direction. Anything other than `"send"` is treated as `"receive"`. */
  type: EmailType;
  /** Bare domain name (the indexed access path). */
  domain: string;
  /**
   * Search query. Substring (case-insensitive `LIKE`); whitespace is
   * collapsed to a single separator and the value is `trim()`-ed.
   * A `q` shorter than 2 chars after trim is rejected at the
   * action / proxy level so a stray keystroke doesn't issue a
   * full-table scan.
   */
  q: string;
  /**
   * Field to match. Defaults to `"body"` — substring against
   * `subject` OR `from_email` OR `to_email` OR `text` OR
   * `content`. The other values restrict to a single column.
   */
  field?: EmailSearchField;
  /**
   * Same repeated `to=` shape as {@link EmailListRequest}; combined
   * with `field="body"`, the local-part filter narrows **after**
   * the LIKE so the indexed access path stays intact.
   */
  to?: string[];
};

/**
 * Response payload for `/api/email/search`. Shape mirrors
 * {@link EmailListResponse}. Each row is hydrated with `isStar` and
 * `attList` so the search results can be opened in the reading pane
 * without a second round trip.
 */
export type EmailSearchResponse = {
  /** Page of rows in descending `id` order. */
  list: EmailListRow[];
  /** Total rows matching the filter (ignoring `size`). */
  total: number;
};

/**
 * Proxy-side args for {@link searchEmails}. The proxy adds the bare
 * `domain` query param (from `domainId`); the `type` is required —
 * the platform never wants to search both inbox and sent in one call.
 */
export type EmailSearchArgs = Omit<EmailSearchRequest, "to" | "domain"> & {
  domainId: string;
  /** Local parts (e.g. `["support", "sales"]`); the proxy composes `local@domain`. */
  localparts?: string[];
};

// ---------------------------------------------------------------------------
// /api/email/thread
// ---------------------------------------------------------------------------

/**
 * Query parameters for `GET /api/email/thread`. The proxy always
 * passes the bare domain name; the worker's `thread` service walks
 * the indexed `(thread_id, id)` partial index to return the chain
 * in ascending `id` order (newest-first scan, then reversed back
 * to oldest → newest for the response).
 */
export type EmailThreadRequest = {
  /** The email id the user clicked; the chain anchor is derived from its `threadId`. */
  emailId: number;
  /** Bare domain name (see {@link EmailListRequest.domain}). */
  domain: string;
  /**
   * When the caller already knows the row's `threadId` (e.g. the
   * list loader surfaced it), passing it here skips the
   * current-row lookup the worker would otherwise issue to derive
   * the chain anchor. The worker trusts the hint as authoritative
   * — the proxy must only forward values it resolved from the
   * caller's own list response.
   */
  threadId?: string;
};

/**
 * Slim row shape for a single chain member. The full `text` /
 * `content` columns are NOT shipped — the worker truncates them
 * via SQL `SUBSTR` at write-out time (see `textPreview` /
 * `contentPreview`) so the conversation response stays bounded
 * regardless of chain length. To render a chain member's full
 * body, the client fetches it on demand via `/api/email/get`.
 */
export type EmailThreadRow = {
  id: number;
  fromEmail: string;
  fromName: string | null;
  toEmail: string;
  toName: string | null;
  subject: string | null;
  type: EmailType;
  status: EmailStatus;
  unread: EmailUnreadFlag;
  createTime: string;
  /** Same as `EmailListRow.sendFeedback`; see that field for the wire
   * contract. Always `null` for receive rows. */
  sendFeedback: string | null;
  isStar: 0 | 1;
  attList: AttachmentInList[];
  /** Threading metadata, preserved so the client can render the chain structure. */
  messageId: string;
  inReplyTo: string;
  threadId: string | null;
  /** First ≤500 chars of the plain-text body; never null after COALESCE. */
  textPreview: string;
  /** First ≤2048 chars of the HTML body; never null after COALESCE. */
  contentPreview: string;
  /** `1` if either `text` or `content` exceeded the preview length and was truncated. */
  bodyTruncated: 0 | 1;
};

/**
 * Response payload for `/api/email/thread`. The `list` is ordered
 * oldest → newest and is a centred window: up to NEIGHBOUR_LIMIT
 * rows older than the current one, then the current one, then up
 * to NEIGHBOUR_LIMIT rows newer than it. The current row's
 * `textPreview` / `contentPreview` fields are overwritten with the
 * full body (and `bodyTruncated` set to 0) so the client can treat
 * every chain row uniformly without splicing in the list row.
 * `total` is the full chain length (not just this window).
 * `hasMoreOlder` / `hasMoreNewer` indicate whether the chain
 * extends beyond the returned window in each direction — v1 doesn't
 * paginate but the flags are exposed for future use.
 */
export type EmailThreadResponse = {
  list: EmailThreadRow[];
  total: number;
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
};

// ---------------------------------------------------------------------------
// /api/email/get — single-row full-body fetch (on-demand thread expand)
// ---------------------------------------------------------------------------

/**
 * Query parameters for `GET /api/email/get`. Used by the ReadingPane
 * to expand a prior message in a conversation chain after the
 * `thread()` preview page has already shipped. The `domain` hint
 * is the IDOR check: the row's `toDomain` / `fromDomain` must
 * match it or the worker treats the row as not-found.
 *
 * **Exactly one** of `emailId` / `messageId` identifies the row.
 *
 * - `emailId` is the numeric row id, which the dashboard has because
 *   it rendered the row.
 * - `messageId` is the SMTP `Message-ID` (1.5.1), which is what the
 *   agent platform's event log records. An agent that read an event
 *   holds a `messageId` and no row id, so before this existed it
 *   could see that a mail arrived but could not fetch what it said.
 *
 * Sending both is a caller bug and is rejected rather than resolved:
 * which key wins would be a precedence the caller cannot see.
 */
export type EmailGetRequest = {
  emailId?: number;
  messageId?: string;
  /** Bare domain name (the same `domain` the thread endpoint receives). */
  domain: string;
};

/**
 * Response payload for `/api/email/get`. Same shape as
 * {@link EmailListRow} (full body, no truncation) so the client
 * can swap it into the existing `EmailItem` slot for the
 * expanded message without any field-name remapping.
 */
export type EmailGetResponse = EmailListRow;

// ---------------------------------------------------------------------------
// /api/email/latest
// ---------------------------------------------------------------------------

/**
 * Query parameters for `GET /api/email/latest`. Returns the most
 * recent 20 rows (server-side cap, no override) past the given
 * cursor — used by the AI agent to "catch up" past a known id.
 */
export type EmailLatestRequest = {
  /** Cursor: only rows with `id > emailId` are returned. */
  emailId?: number;
  /** Mailbox direction. */
  type: EmailType;
  /** Bare domain name. */
  domain: string;
};

/**
 * Response payload for `/api/email/latest`. The shape matches
 * {@link EmailListRow} but **does not** include the `isStar` field —
 * the worker's `latest` path doesn't join the `star` table.
 */
export type EmailLatestResponse = EmailListRow[];

// ---------------------------------------------------------------------------
// /api/email/send (new outbound + reply share the same endpoint and
// the same worker-side `dispatchOutbound` function — see
// `apps/email-worker/src/service/email-service.js`).
// ---------------------------------------------------------------------------

/** Attachment reference passed to `/api/email/send`. */
export type EmailSendAttachment = {
  /** R2 object key the worker should record against the new email. */
  key: string;
  /** Filename to surface in the recipient's mail client. */
  filename: string;
  /** MIME type — the worker forwards it to the relay. */
  mimeType: string;
  /** Byte size; used for quota / display, not enforcement. */
  size: number;
};

/**
 * Request body for `POST /api/email/send`.
 *
 * The wire format is the resolved (frontend-decided) shape: the
 * caller has already picked the `from` address, the `to` list, and
 * (if this row is part of a conversation) the `threading` columns.
 * The worker does not look up a parent row, does not derive a
 * `fromEmail` from a display name, and does not synthesise a
 * `threadId` from the SMTP `Message-ID` — the platform side hands
 * over exactly what should land on the row and in the SMTP envelope.
 *
 * A row is treated as a "reply" (SMTP `In-Reply-To` / `References`
 * headers set; thread anchor taken from `threading.threadId`) if and
 * only if `threading` is set. A new send omits `threading`; the
 * worker then stamps the SMTP-assigned `Message-ID` as `threadId`
 * after the send returns.
 *
 * `subject` is always required (non-empty) — the platform's
 * `InlineReplyComposer` defaults to `Re: <parentSubject>`, so a
 * missing subject is a caller bug rather than a feature.
 */
export type EmailSendRequest = {
  /** Domain the worker is bound to (also acts as the IDOR scope). */
  domain: string;
  /**
   * Resolved sender address, e.g. `"sales@flowmails.app"`. The
   * platform's `resolveFromAddress` helper already validates the
   * local-part against the route table; the worker trusts whatever
   * is passed here.
   */
  from: string;
  /**
   * Optional display name for the sender (e.g. `"Sales"`). The
   * worker falls back to `emailUtils.getName(from)` (the
   * local-part, capitalised) when this is absent, so the column is
   * never blank in the UI.
   */
  fromName?: string;
  /**
   * Recipient addresses. The worker requires at least one and
   * validates each with `verifyUtils.isEmail`; a non-email entry
   * is rejected with `BizError('notEmail')`. A `manyType: "divide"`
   * send yields one row per recipient; a `manyType: "together"`
   * (or omitted) send yields a single envelope with all recipients.
   */
  to: string[];
  /** One-envelope-per-recipient vs. single-envelope. Defaults to
   * `"together"` when omitted. */
  manyType?: "divide" | "together";
  /** Subject line. Non-empty; the worker stores the column as
   * provided (no `Re:` prefixing — the caller is responsible for
   * the prefix). */
  subject: string;
  /** Plain-text body. At least one of `text` / `content` is required. */
  text?: string;
  /** HTML body. Inline `cid:` images are auto-extracted into
   * `embed` attachments by the worker. */
  content?: string;
  /**
   * Optional `Reply-To` header — where the recipient's reply should
   * go, when it is not the `from` address.
   *
   * The header is set on the outbound envelope, so it is **not**
   * stored as a column: the `from` address stays the address the row
   * shows in the Sent tab, and `Reply-To` only steers the reply.
   *
   * Omit it and the worker sets no `Reply-To` at all — which is not
   * the same as setting it to `from`. Cloudflare's Email Services
   * defaults the header to the envelope sender when it is absent, so
   * "unset" and "set to `from`" produce the same delivered header;
   * the difference only matters when a caller wants replies to land
   * somewhere other than the sending address.
   *
   * The worker rejects a malformed value with `BizError('notEmail')`
   * rather than forwarding it, because Cloudflare's builder would
   * otherwise drop the header silently and the caller would never
   * learn that the reply went to the wrong place.
   */
  replyTo?: string;
  /**
   * Pre-uploaded attachments. Each entry references an R2 key the
   * caller (or an earlier upload helper) has already written; the
   * worker inserts the metadata row and leaves the R2 object alone.
   */
  attachments?: EmailSendAttachment[];
  /**
   * Conversation threading columns. Omit for a brand-new send (the
   * worker will stamp `threadId` from the SMTP `Message-ID` after
   * the send returns). Set for a reply; the caller is responsible
   * for deriving `inReplyTo` / `references` / `threadId` from the
   * parent row (the emailbox action handler inlines this derivation
   * — see `apps/web/app/routes/dashboard.emailbox.tsx` around the
   * `intent: "reply"` case).
   *
   * Presence of this field is also what tells the worker to add
   * `In-Reply-To` / `References` headers to the SMTP envelope —
   * the recipient's mail client uses those to thread the new
   * message with the original conversation.
   */
  threading?: {
    /** SMTP `In-Reply-To` value (the parent row's `messageId`). */
    inReplyTo: string;
    /** `References` chain value, parent row's `messageId` appended
     * to the parent's own `references` array, JSON-encoded. */
    references: string;
    /** Conversation anchor — the root row's `messageId`, or the
     * parent row's `messageId` if the parent itself was orphaned. */
    threadId: string;
  };
};

/**
 * Result row as returned by `/api/email/send`. The worker always
 * returns an array — a single send yields a one-element list, a
 * `manyType: "divide"` send yields one element per recipient. Each
 * element is a slim projection of {@link EmailListRow} via the
 * worker's `toEmailRowResult` helper; the web client flattens this
 * with `await resp.json()` + `.data ?? []`.
 */
export type EmailSendResult = {
  /** Mirrors `email.id`; the client uses this to navigate to the sent row. */
  emailId: number;
  /** Sender address; equals `fromEmail` on the underlying row. */
  sendEmail: string;
  /** Sender display name; empty string when null on the row. */
  name: string;
  subject: string;
  text: string;
  content: string;
  type: EmailType;
  status: EmailStatus;
  /** JSON-serialised `Array<{ address, name }>`; preserved as a string. */
  recipient: string;
  /** SMTP `Message-ID` assigned by the relay. Empty when the send failed. */
  resendEmailId: string;
  unread: EmailUnreadFlag;
  createTime: string;
  /** Always `0` in this projection — the worker doesn't join the `star` table. */
  isStar: 0;
  attList: AttachmentInList[];
  /**
   * Relay-side error string when `status === 8` (FAILED). The
   * worker writes the SMTP error message into
   * `email.send_feedback` at the moment the send fails; `null`
   * when the row succeeded.
   */
  sendFeedback: string | null;
};

/** Convenience alias for the response shape of `/api/email/send`. */
export type EmailSendResponse = EmailSendResult[];

// ---------------------------------------------------------------------------
// /api/email/read (PUT)
// ---------------------------------------------------------------------------

/** Request body for `PUT /api/email/read`. */
export type EmailReadRequest = {
  /** Ids of the rows to mark as read. The worker ignores ids it can't find. */
  emailIds: number[];
};

/** Response payload. The worker emits `data: null`; the type is the empty object. */
export type EmailReadResponse = Record<string, never>;

// ---------------------------------------------------------------------------
// /api/email/unread (PUT) — reverse of `/api/email/read`
// ---------------------------------------------------------------------------

/**
 * Request body for `PUT /api/email/unread`. Inverse of {@link EmailReadRequest}.
 *
 * The action is inverts the read-side invariant: the worker first flips
 * `email.unread = 1` for every matching row, then bumps the per-mailbox
 * counter via `unreadcountService.batchedIncrement`. Order matters —
 * mutating the `email` row first means a dropped cache update leaves the
 * count high (recoverable on the next read) instead of low (a
 * user-visible undercount). See `apps/email-worker/src/service/
 * email-service.js#markUnread` and CLAUDE.md's `unreadcount` invariant.
 */
export type EmailUnreadRequest = {
  /** Ids of the rows to flag as unread again. The worker ignores ids it can't find. */
  emailIds: number[];
};

/** Response payload. The worker emits `data: null`. */
export type EmailUnreadResponse = Record<string, never>;

// ---------------------------------------------------------------------------
// /api/email/readAll (PUT) — "mark all as read" over a mailbox scope
// ---------------------------------------------------------------------------

/**
 * Request body for `PUT /api/email/readAll`. Added in receive-worker
 * 1.4.1; a worker older than that answers a plain `404` on this path,
 * which the platform proxy maps to a `ServiceError(409, …)` upgrade
 * hint rather than a generic gateway error.
 *
 * Unlike {@link EmailReadRequest}, which takes an explicit id list and
 * therefore can only ever cover the page the caller happens to hold,
 * this endpoint takes the **same scope the inbox list is built from**
 * and flips every unread inbound row inside it in one statement:
 *
 *   - only `type = 'receive'` rows are touched — outbound rows are
 *     inserted with `unread = 0` and the unread cache is scoped to
 *     inbound receives only (CLAUDE.md's `unreadcount` invariant);
 *   - `domain` is the IDOR boundary and is always applied;
 *   - `to` narrows to a set of recipient localparts (the emailbox
 *     multi-pick). Omit it for "every mailbox on this domain".
 *
 * The worker keeps the `unreadcount` cache honest the same way
 * {@link EmailReadRequest} does: snapshot the affected mailboxes,
 * mutate the rows, then `batchedDecrement` — so a dropped cache write
 * leaves the count high (recoverable) rather than low.
 */
export type EmailReadAllRequest = {
  /** Bare domain name (no `@`) — the mailbox scope to clear. */
  domain: string;
  /**
   * Optional localpart narrowing. The web proxy composes full
   * `local@domain` addresses into this list (the same repeated `to=`
   * field `/api/email/list` takes); the worker strips the domain back
   * off before matching the `to_local` virtual column, so bare
   * localparts work too.
   */
  to?: string[];
};

/**
 * Response payload for {@link EmailReadAllRequest}.
 *
 * `updated` is the number of rows whose unread flag actually flipped —
 * `0` when the scope was already fully read. The count comes from the
 * same GROUP BY snapshot the cache update is driven by, so it is exact
 * rather than inferred from the client's current page.
 */
export type EmailReadAllResponse = {
  updated: number;
};

// ---------------------------------------------------------------------------
// /api/email/delete (DELETE) and /api/email/batchDelete
// ---------------------------------------------------------------------------

/**
 * Query parameters for `DELETE /api/email/delete`. The endpoint
 * accepts a single id, a comma-separated list, or a repeated
 * `emailIds=` query param; the proxy normalises to the comma form.
 *
 * Note: this path now delegates to `batchDelete` internally, so
 * attachments and the unread-count cache are correctly maintained —
 * the legacy "leave R2 orphans" bug is gone. Prefer `batchDelete`
 * only when you're already working with a known id set.
 */
export type EmailDeleteRequest = {
  /** One or more ids; comma-separated or repeated. */
  emailIds: number[] | string;
};

/** Response payload. The worker emits `data: null`. */
export type EmailDeleteResponse = Record<string, never>;

/**
 * Query parameters for `DELETE /api/email/batchDelete`. The web
 * client always sends the comma-separated form. Unlike
 * {@link EmailDeleteRequest}, this endpoint is the documented
 * multi-row path — the emailbox multi-select calls it directly.
 */
export type EmailBatchDeleteRequest = {
  emailIds: number[] | string;
};

/** Response payload. The worker emits `data: null`. */
export type EmailBatchDeleteResponse = Record<string, never>;

// ---------------------------------------------------------------------------
// /api/email/attList
// ---------------------------------------------------------------------------

/** Query parameters for `GET /api/email/attList`. */
export type EmailAttachmentListRequest = {
  /** Email id whose non-`embed` attachments should be returned. */
  emailId: number;
};

/**
 * Response payload. Each entry is the raw `AttachmentRow` — the
 * worker does NOT prepend the R2 domain here (the caller knows
 * the email and can compute it).
 */
export type EmailAttachmentListResponse = AttachmentRow[];

// ---------------------------------------------------------------------------
// /api/email/countUnread (POST, multi-domain)
// ---------------------------------------------------------------------------

/** Request body for `POST /api/email/countUnread`. */
export type EmailCountUnreadRequest = {
  /** Domains to total. The worker caps each `IN (?, ?, …)` clause at 64 placeholders. */
  domains: string[];
};

/**
 * Response payload: per-domain total of unread rows. Domains in the
 * request with no unreadcount rows are returned as `0` so callers
 * can render a complete map.
 */
export type EmailCountUnreadResponse = Record<string, number>;

// ---------------------------------------------------------------------------
// Junk folder (1.2.0+).
//
// Inbound messages that the Rspamd check classifies as spam or
// phishing are moved out of the live `email` table into a parallel
// `junk_email` table on the same D1. The worker stamps the spam
// scoring metadata onto the junk row so the UI can show "why was this
// flagged" and the user can decide to restore it (which copies the row
// back into `email` with the spam fields stripped).
//
// Attachments ride along on the regular `attachments` table —
// migration 1.2.0 added a `junk_email_id` companion column so a
// single row can be parented to either `email` or `junk_email`.
// `markAsJunk` stamps the new column; `restoreFromJunk` rewrites
// `email_id` to the freshly-inserted live row and clears
// `junk_email_id`; `deleteJunk` cascades through
// `attService.removeByJunkEmailIds` so the R2 object is dropped in
// lockstep with the junk row. The Junk tab UI still doesn't render
// attachments (V1 intentionally keeps the surface narrow) but
// restoring a row brings its attachments back automatically.
//
// /api/email/junkList      GET    paginated list (same shape as /email/list)
// /api/email/junkRestore   POST   copy a junk row back into `email`
// /api/email/junkDelete    DELETE hard-delete one or more junk rows
// /api/email/countJunk     POST   per-domain unread-junk totals
// ---------------------------------------------------------------------------

/**
 * Row shape for the junk folder. Mirrors {@link EmailListRow} but
 * omits `threadId` (junk mail is rarely threaded and we don't keep
 * the parent-link column on the junk table) and adds the Rspamd
 * scoring fields. `attList` is always empty — see the file-level
 * note above.
 */
export type EmailJunkListRow = {
  /** Auto-increment row id on the `junk_email` table. */
  id: number;

  // Sender addressing
  fromEmail: string;
  fromLocal: string;
  fromDomain: string;
  fromName: string | null;

  // Recipient addressing
  toEmail: string;
  toLocal: string;
  toDomain: string;
  toName: string | null;

  // Content
  subject: string | null;
  /** Plain-text body. */
  text: string | null;
  /** HTML body. */
  content: string | null;

  // Multi-recipient metadata (JSON-encoded arrays)
  cc: string;
  bcc: string;
  recipient: string | null;

  // Conversation threading (kept for fidelity; junk rows are not
  // surfaced in the conversation thread query, but the upstream
  // Message-ID / In-Reply-To are preserved so a restored row can
  // re-attach to a chain).
  messageId: string;
  inReplyTo: string;

  // Routing / state
  status: EmailStatus;
  unread: EmailUnreadFlag;
  /** SQL `CURRENT_TIMESTAMP`; string, not a number. */
  createTime: string;
  /** Junk rows are never starred from the emailbox UI. */
  isStar: 0;
  /** Always empty — see the file-level note above. */
  attList: never[];

  // Rspamd scoring metadata (always present; the worker stamps
  // them at the moment of move-to-junk).
  /** Numeric score returned by Rspamd. */
  spamScore: number;
  /** Rspamd's verdict string — `"reject"`, `"add header"`, `"greylist"`,
   * `"ham"`, or one of its other action labels. The classification
   * rule is "junk ⇔ action === 'reject'", but the raw value is
   * exposed so the UI can show why something was flagged. */
  spamAction: string;
  /** Score at which Rspamd would have rejected the message. */
  spamRequiredScore: number;
  /** JSON-encoded `Record<symbolName, { score, description }>` so
   * the UI can surface the top contributors. */
  spamSymbols: string | null;
  /** Unix epoch (ms) of when the score was recorded. */
  spamCheckedAt: number;
};

/** Query parameters for `GET /api/email/junkList`. */
export type EmailJunkListRequest = EmailWorkerPaginationParams & {
  /** Bare domain name. The worker filters on `to_domain = ?` (junk
   * rows are always inbound, so the recipient's domain is the right
   * indexed column). */
  domain: string;
  /** Same repeated `to=` shape as {@link EmailListRequest}. */
  to?: string[];
};

/** Response payload for `/api/email/junkList`. */
export type EmailJunkListResponse = {
  list: EmailJunkListRow[];
  total: number;
};

/** Proxy-side args for {@link listJunk}. */
export type EmailJunkListArgs = Omit<
  EmailJunkListRequest,
  "to" | "domain"
> & {
  domainId: string;
  localparts?: string[];
};

/** Request body for `POST /api/email/junkRestore`. */
export type EmailJunkRestoreRequest = {
  /** Junk row id to restore. */
  junkId: number;
  /** Bare domain name; the worker uses it as the IDOR scope (the
   * row's `toDomain` must match). */
  domain: string;
};

/**
 * Response payload for `/api/email/junkRestore`. The worker deletes
 * the junk row and inserts a fresh row in `email` with the spam
 * fields stripped. Returns the new email row id so the UI can jump
 * the user to it. Attachments are not restored (see the file-level
 * note above).
 */
export type EmailJunkRestoreResponse = {
  /** Newly-inserted `email.id` on the live table. */
  emailId: number;
};

/** Query parameters for `DELETE /api/email/junkDelete`. */
export type EmailJunkDeleteRequest = {
  /** One or more junk row ids; comma-separated or repeated. */
  junkIds: number[] | string;
};

/** Response payload for `/api/email/junkDelete`. The worker emits `data: null`. */
export type EmailJunkDeleteResponse = Record<string, never>;

// ---------------------------------------------------------------------------
// /api/email/countJunk (POST, multi-domain)
// ---------------------------------------------------------------------------

/** Request body for `POST /api/email/countJunk`. */
export type EmailCountJunkRequest = {
  /** Domains to total. Same placeholder-chunking contract as
   * {@link EmailCountUnreadRequest}. */
  domains: string[];
};

/**
 * Per-domain unread-junk totals. Drives the Junk-tab badge so the
 * user can see at a glance how many flagged messages are waiting
 * to be reviewed. Domains with no unread junk rows return `0`.
 */
export type EmailCountJunkResponse = Record<string, number>;

// ---------------------------------------------------------------------------
// /api/email/countUnreadByDomain (GET, single domain)
// ---------------------------------------------------------------------------

/** Query parameters for `GET /api/email/countUnreadByDomain`. */
export type EmailCountUnreadByDomainRequest = {
  /** Bare domain name. */
  domain: string;
};

/**
 * Per-recipient unread count for a single domain. The keys are
 * recipient addresses (`toEmail` on the unreadcount table); the
 * values are integer counts. The dashboard sums the values to
 * derive a per-domain total.
 */
export type EmailCountUnreadByDomainResponse = Record<string, number>;

// ---------------------------------------------------------------------------
// Proxy helper response types.
//
// The platform proxy (`email-worker-proxy.ts`) returns a raw
// `Response` from every helper and lets the caller decode. These
// aliases document the convention so loaders/actions can `.json()`
// the response and cast to the right shape.
// ---------------------------------------------------------------------------

/** Proxy helper for {@link EmailListRequest} / {@link EmailThreadRequest}. */
export type EmailListOrThreadProxyResponse = EmailWorkerHttpResponse;

/** Proxy helper for {@link EmailSendRequest}. */
export type EmailSendProxyResponse = EmailWorkerHttpResponse;

/** Proxy helper for {@link EmailReadRequest} / {@link EmailDeleteRequest} / {@link EmailBatchDeleteRequest}. */
export type EmailMutationProxyResponse = EmailWorkerHttpResponse;

/** Proxy helper for {@link EmailAddStarRequest} / {@link EmailCancelStarRequest}. */
export type EmailStarProxyResponse = EmailWorkerHttpResponse;

/** Proxy helper for {@link EmailAttachmentListRequest}. */
export type EmailAttachmentListProxyResponse = EmailWorkerHttpResponse;

// ---------------------------------------------------------------------------
// Star endpoints (re-exported from the star module but declared here
// for the proxy so the imports stay flat).
// ---------------------------------------------------------------------------

/**
 * Request body for `POST /api/star/add`. Idempotent: the worker
 * silently ignores duplicate stars for the same `emailId`.
 */
export type EmailAddStarRequest = {
  emailId: number;
};

/**
 * Request body for `DELETE /api/star/cancel`. The worker always
 * issues a `DELETE FROM star WHERE email_id = ?` so calling on a
 * non-starred row is a no-op.
 */
export type EmailCancelStarRequest = {
  emailId: number;
};

/** Response payload for both `add` and `cancel`. The worker emits `data: null`. */
export type EmailStarMutationResponse = Record<string, never>;

/** Query parameters for `GET /api/star/list`. */
export type EmailStarListRequest = {
  /** Cursor: rows with `starId < emailId` are returned (the star column is a left-join alias). */
  emailId?: number;
  /** Page size. */
  size?: number;
};

/**
 * Response payload. Each row mirrors {@link EmailListRow} (the
 * worker left-joins the `email` table) plus the originating
 * `starId` and a literal `isStar: 1` for downstream symmetry.
 */
export type EmailStarListResponse = {
  list: EmailListRow[];
};
