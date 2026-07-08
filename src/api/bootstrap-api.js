import app from '../hono/hono';
import { t } from '../i18n/i18n';
import bootstrapService from '../service/bootstrap-service';

app.get('/bootstrap', async (c) => {
  await bootstrapService.bootstrap(c);
  return c.text(t('initSuccess'));
})
