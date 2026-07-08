import app from '../hono/hono';

app.get('/ok', async (c) => {
	return c.text('ok');
});
