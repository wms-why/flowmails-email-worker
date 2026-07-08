import app from '../hono/hono';
import result from '../utils/result';
import starService from '../service/star-service';

app.post('/star/add', async (c) => {
  await starService.add(c, await c.req.json());
  return c.json(result.ok());
});

app.get('/star/list', async (c) => {
  const data = await starService.list(c, c.req.query());
  return c.json(result.ok(data));
});

app.delete('/star/cancel', async (c) => {
  await starService.cancel(c, await c.req.json());
  return c.json(result.ok());
});
