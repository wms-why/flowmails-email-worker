const KvConst = {
  SEND_DAY_COUNT: 'send_day_count:',
  USER_CONFIG: 'user_config:',
  SETTING: 'setting:',
  LAST_VERSION: 'last_version:',
  // No DEVELOPER_API_KEY prefix here after 2026-07-05 cleanup —
  // the per-account email-worker no longer mirrors sdk keys to KV
  // (see `apps/email-worker/src/service/security.js`).
};

export default KvConst;
