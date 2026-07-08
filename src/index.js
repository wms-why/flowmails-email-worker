import { email } from './service/email-receive';
import app from './hono/webs';
import emailService from './service/email-service';
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      url.pathname = url.pathname.replace('/api', '');
      req = new Request(url.toString(), req);
      return app.fetch(req, env, ctx);
    }

    return env.assets.fetch(req);
  },
  email,
  async scheduled(c, env) {
    await emailService.completeReceiveAll({ env });
  },
};
