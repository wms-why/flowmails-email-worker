import constant from '../const/constant';
import BizError from '../utils/biz-error';
import app from '../hono/hono';
import { t } from '../i18n/i18n';
import jwtUtils from '../utils/jwt-utils';

// Paths that bypass auth entirely — currently just the `/ok` health
// probe. The receive-worker has no third-party API-key surface any
// more after the 2026-07-05 cleanup; the only valid caller is the
// platform web app holding the per-account `JWT_SECRET`. SDK keys
// live in `apps/sdk-backend` exclusively; this worker only answers
// platform-internal traffic from `apps/web`.
const ignorePaths = ['/ok'];

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (ignorePaths.includes(url.pathname)) {
    return await next();
  }

  const authHeader = c.req.header(constant.JWT_HEADER);

  if (!authHeader) {
    throw new BizError(t('authExpired'), 401);
  }

  const jwtResult = await jwtUtils.verifyToken(c, authHeader);

  if (jwtResult) {
    c.set('auth', { type: 'internal' });
    c.set('user', {
      userId: 1,
      email: 'admin',
      role: 'admin',
    });
    return await next();
  }

  // Anything that is not a literal `Bearer ${JWT_SECRET}` is now an
  // unconditional 401 — there is no third-party dev-key path on this
  // worker. SDK callers must hit `apps/sdk-backend`; per-account
  // platform traffic keeps flowing in unchanged.
  throw new BizError(t('authExpired'), 401);
});