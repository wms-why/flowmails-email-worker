/**
 * Type definitions for the analysis endpoint of the
 * `flowmails-receive-worker` HTTP API.
 *
 * The `/api/analysis/echarts` route lives in
 * `apps/email-worker/src/api/analysis-api.js` and is the source for
 * the dashboard's mailbox-statistics widgets. The response is a
 * composite of four DAOs (`numberCount`, `userDayCount`,
 * `receiveDayCount`, `sendDayCount`) plus a single KV lookup for
 * today's sent-mail counter.
 */

import type { EmailWorkerPaginationParams } from "./envelope.ts";

// ---------------------------------------------------------------------------
// /api/analysis/echarts (GET)
// ---------------------------------------------------------------------------

/** Query parameters for `GET /api/analysis/echarts`. */
export type AnalysisEchartsRequest = EmailWorkerPaginationParams & {
  /**
   * IANA timezone id (e.g. `"Asia/Shanghai"`). The worker converts
   * "today" to the user's local day using this offset when bucketing
   * the per-day counts.
   */
  timeZone: string;
};

/**
 * One bucket in a per-day time series. The worker returns 15 entries
 * (yesterday and the 14 days before that); the dashboard renders
 * them as a bar / line chart.
 */
export type AnalysisDayCount = {
  /** Local date in `YYYY-MM-DD` form (per the request's `timeZone`). */
  date: string;
  /** Count for that day. */
  total: number;
};

/**
 * The `numberCount` DAO: aggregate totals for the whole mailbox.
 * Single-user deployments return `1` / `0` for the `*Account` /
 * `*User` fields; multi-tenant installs (when the DAOs are wired up
 * with the user table) compute real values.
 */
export type AnalysisNumberCount = {
  receiveTotal: number;
  sendTotal: number;
  delReceiveTotal: number;
  delSendTotal: number;
  normalReceiveTotal: number;
  normalSendTotal: number;
  accountTotal: number;
  normalAccountTotal: number;
  delAccountTotal: number;
  userTotal: number;
  normalUserTotal: number;
  delUserTotal: number;
};

/** Response payload for `/api/analysis/echarts`. */
export type AnalysisEchartsResponse = {
  /** Lifetime totals. */
  numberCount: AnalysisNumberCount;
  /** Daily per-user send counts. Single-user mode returns an empty array. */
  userDayCount: AnalysisDayCount[];
  /** Top senders by name. */
  receiveRatio: {
    /** Up to 6 entries; `noreply` / empty names are filtered out server-side. */
    nameRatio: Array<{ name: string; total: number }>;
  };
  /** Daily receive / send volumes (15 entries each, oldest → newest). */
  emailDayCount: {
    receiveDayCount: AnalysisDayCount[];
    sendDayCount: AnalysisDayCount[];
  };
  /** Today's sent-mail counter, read from KV. `0` if the key is unset. */
  daySendTotal: number;
};
