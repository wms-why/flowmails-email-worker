import app from '../hono/hono';
import result from '../utils/result';
import routeService from '../service/route-service';

/**
 * 收信路由表的三个端点。
 *
 * 由平台 web worker (`apps/web`) 通过 per-account JWT 调用 ——
 * `service/security.js` 的 `*` 中间件已经覆盖了这些路径，它们不
 * 在 `/ok` 白名单里，拿不到 `Bearer ${JWT_SECRET}` 一律 401。
 *
 * 线的契约 (`RouteRuleSetRequest` / `RouteRuleSetResponse` /
 * `RouteRuleClearRequest` / `RouteRuleClearResponse`) 定义在
 * `packages/emailworker-types/src/route.ts`，平台侧必须同步一份到
 * `apps/email-worker/packages/emailworker-types/src/route.ts`。
 *
 * 注意：这三个端点是 1.4.0 才有的。老版本 worker 上访问会走到
 * Hono 的 404，平台侧把它翻译成「请先升级 worker」的 409。
 */

app.get('/route/get', async (c) => {
	const rule = await routeService.get(c.env, c.req.query('domain'));
	// `null` 是合法返回值：表示该域名没有路由表 = 全收。平台侧把它
	// 折叠成 `{ mode: 'catchall', localParts: [] }` 再往 D1 绑定上比对。
	return c.json(result.ok(rule));
});

app.put('/route/set', async (c) => {
	const body = await c.req.json();
	const rule = await routeService.set(c.env, body.domain, body.mode, body.localParts);
	return c.json(result.ok(rule));
});

app.delete('/route/clear', async (c) => {
	const cleared = await routeService.clear(c.env, c.req.query('domain'));
	return c.json(result.ok(cleared));
});
