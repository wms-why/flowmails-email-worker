/**
 * Type definitions for the AI agent endpoints of the
 * `flowmails-receive-worker` HTTP API.
 *
 * The `/api/agent/chat` and `/api/agent/tools/call` routes are
 * declared in `apps/email-worker/src/api/ai-agent-api.js`. The chat
 * endpoint is a streaming SSE pass-through to Cloudflare's
 * `llama-3.1-8b-instruct` model; the tools endpoint is a router
 * that dispatches to the per-tool implementations in
 * `apps/email-worker/src/service/ai-agent-service.js`.
 *
 * The platform web worker doesn't call these directly — they sit
 * behind the dashboard's AI assistant surface — but the type
 * definitions live in this shared submodule so any future web-side
 * caller (e.g. a copilot) can use them with no glue code.
 */

import type { EmailListRow } from "./email.ts";

// ---------------------------------------------------------------------------
// /api/agent/chat  (Server-Sent Events pass-through)
// ---------------------------------------------------------------------------

/** OpenAI-style chat message. The worker forwards these to the CF AI gateway verbatim. */
export type AgentChatMessage = {
  /** One of the four standard OpenAI roles. The worker passes through unknown values. */
  role: "system" | "user" | "assistant" | "tool" | string;
  /** Plain-text content. */
  content: string;
  /**
   * Optional tool-call id, used to pair an assistant `tool_calls`
   * entry with the corresponding `role: "tool"` response.
   */
  tool_call_id?: string;
  /** Tool calls requested by the assistant in the previous turn. */
  tool_calls?: AgentChatToolCall[];
};

/** A single function call the assistant wants to dispatch. */
export type AgentChatToolCall = {
  /** Stable id; required when the model is responding to a tool result. */
  id: string;
  /** Always `"function"` for the CF AI gateway. */
  type: "function";
  function: {
    /** Tool name from {@link AgentToolName}. */
    name: string;
    /** JSON-encoded argument object. */
    arguments: string;
  };
};

/** Tool descriptor in OpenAI function-calling format. */
export type AgentChatTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/** Request body for `POST /api/agent/chat`. */
export type AgentChatRequest = {
  /** Conversation so far. */
  messages: AgentChatMessage[];
  /** Tool catalogue. Defaults to the worker's built-in {@link ToolDefinitions} when omitted. */
  tools?: AgentChatTool[];
  /** Sampling temperature. The worker passes through to the CF AI gateway. */
  temperature?: number;
  /** Cap on completion tokens. The worker passes through. */
  max_tokens?: number;
  /**
   * Cloudflare account id whose token should be used to authenticate
   * with the CF AI gateway. Required — the worker throws if missing.
   */
  accountId: string;
  /** Bare domain name; included for telemetry / scoping (not used by the worker today). */
  domain?: string;
};

/**
 * Response shape for `/api/agent/chat`. The worker does NOT wrap this
 * in the standard `result.ok(...)` envelope — the raw `text/event-stream`
 * is streamed straight through. Consumers should treat the
 * `Response` as opaque and consume `response.body` via
 * `ReadableStream`.
 */
export type AgentChatResponse = Response;

// ---------------------------------------------------------------------------
// /api/agent/tools/call
// ---------------------------------------------------------------------------

/**
 * Tool names accepted by `/api/agent/tools/call`. Mirrors the
 * `switch` in `apps/email-worker/src/api/ai-agent-api.js`. Any other
 * value causes the worker to return `400` with `Unknown tool: <name>`.
 */
export type AgentToolName =
  | "list_emails"
  | "read_email"
  | "search_emails"
  | "draft_email"
  | "draft_reply"
  | "draft_forward"
  | "send_email"
  | "mark_read"
  | "delete_email";

/** Per-tool parameter shape. */
export type AgentToolParams = {
  list_emails: AgentListEmailsParams;
  read_email: AgentReadEmailParams;
  search_emails: AgentSearchEmailsParams;
  draft_email: AgentDraftEmailParams;
  draft_reply: AgentDraftReplyParams;
  draft_forward: AgentDraftForwardParams;
  send_email: AgentSendEmailParams;
  mark_read: AgentMarkReadParams;
  delete_email: AgentDeleteEmailParams;
};

/** `list_emails` parameters. */
export type AgentListEmailsParams = {
  /** One of `inbox`, `sendbox`, `drafts`, `archive`, `trash`. The worker maps these to `type`. */
  folder: "inbox" | "sendbox" | "drafts" | "archive" | "trash" | string;
  /** Page size. Defaults to 20 server-side. */
  limit?: number;
  /** Cursor passed as `emailId`; only rows with `id > offset` are returned. */
  offset?: number;
};

/** `read_email` parameters. */
export type AgentReadEmailParams = {
  emailId: number;
};

/** `search_emails` parameters. */
export type AgentSearchEmailsParams = {
  /** Free-text query; the worker splits on whitespace and ANDs the substrings together. */
  query: string;
  /** Optional folder scoping. */
  folder?: AgentListEmailsParams["folder"];
  /** Page size. Defaults to 20 server-side. */
  limit?: number;
};

/** `draft_email` parameters. The worker never sends this; it just returns a draft envelope. */
export type AgentDraftEmailParams = {
  to: string[];
  subject: string;
  content: string;
  cc?: string[];
  bcc?: string[];
};

/** `draft_reply` parameters. */
export type AgentDraftReplyParams = {
  emailId: number;
  content: string;
  /** When true, the draft header reads "Reply All" instead of "Reply". */
  replyAll?: boolean;
};

/** `draft_forward` parameters. */
export type AgentDraftForwardParams = {
  emailId: number;
  content: string;
  to: string[];
};

/** `send_email` parameters — the worker forwards the draft to `/api/email/send`. */
export type AgentSendEmailParams = {
  draftEmail: {
    to: string[];
    subject: string;
    content: string;
    cc?: string[];
    bcc?: string[];
  };
};

/** `mark_read` parameters. */
export type AgentMarkReadParams = {
  emailId: number;
  /** `true` to mark as read, `false` to mark as unread. The worker only acts when `true`. */
  read: boolean;
};

/** `delete_email` parameters. */
export type AgentDeleteEmailParams = {
  emailId: number;
};

/** Request body for `POST /api/agent/tools/call`. */
export type AgentToolCallRequest = {
  toolName: AgentToolName;
  params: AgentToolParams[AgentToolName];
  /** Bare domain name; threaded into the underlying email-service calls. */
  domain?: string;
};

/** Per-tool result type. The worker always returns `data` as one of these. */
export type AgentToolResult = {
  list_emails: { list: EmailListRow[]; total: number };
  read_email: EmailListRow | null;
  search_emails: EmailListRow[];
  draft_email: AgentDraftEnvelope;
  draft_reply: AgentDraftEnvelope;
  draft_forward: AgentDraftEnvelope;
  send_email: { success: true; emailId: number; message: string };
  mark_read: { success: true; emailId: number; read: boolean };
  delete_email: { success: true; emailId: number };
};

/** Draft envelope returned by the `draft_*` tools. The worker never persists this. */
export type AgentDraftEnvelope = {
  /** Synthetic id; pattern is `draft_<timestamp>_<rand>` or `reply_<id>_<ts>` / `forward_<id>_<ts>`. */
  draftId: string;
  /** Recipient(s). The reply tool pins this to the parent's `fromEmail`. */
  to: string | string[];
  /** Optional Cc / Bcc — only `draft_email` accepts these. */
  cc?: string[];
  bcc?: string[];
  subject: string;
  content: string;
  /** Always the literal string `"draft"`. */
  status: "draft";
};
