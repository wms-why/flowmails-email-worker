import app from '../hono/hono';
import result from '../utils/result';
import analysisService from '../service/analysis-service';

app.get('/analysis/echarts', async (c) => {
  const data = await analysisService.echarts(c, c.req.query());
  return c.json(result.ok(data));
})
