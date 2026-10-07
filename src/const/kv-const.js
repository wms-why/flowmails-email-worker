const KvConst = {
  SEND_DAY_COUNT: 'send_day_count:',
  USER_CONFIG: 'user_config:',
  SETTING: 'setting:',
  LAST_VERSION: 'last_version:',
  // 每域名的收信路由表 (catch-all / 白名单)，由平台通过
  // `PUT /api/route/set` 写入，收信热路径在 `email-receive.js` 里读取。
  // 详见 `src/service/route-service.js`。
  ROUTE_RULES: 'route_rules:',
  // No DEVELOPER_API_KEY prefix here after 2026-07-05 cleanup —
  // the per-account email-worker no longer mirrors sdk keys to KV
  // (see `apps/email-worker/src/service/security.js`).
};

export default KvConst;
