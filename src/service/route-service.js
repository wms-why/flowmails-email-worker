/**
 * 收信路由表 (route rules)。
 *
 * Cloudflare Email Routing 现在只保留一条 catch-all → worker 的规则，
 * 具体「哪些 localpart 收信」完全由本服务在 worker 内部判定：
 *
 *   - `catchall` (缺省) — 该域名的所有地址都收信。KV 里没有 key、
 *     或者显式存了 `mode: "catchall"`，都走这一支。
 *   - `rules`            — 只有 `localParts` 里列出的 localpart 收信，
 *     其余地址在 `email-receive.js` 里被 `message.setReject()` 550 退信。
 *
 * 存储：KV，key = `route_rules:<域名全小写>`，value 为下面这个形状的 JSON。
 * KV 命名空间是**账号级**的（一个 worker 服务该账号下的全部域名），
 * 所以 key 里必须带域名。
 *
 *   { "domain": "example.com", "mode": "rules",
 *     "localParts": ["support", "sales"], "updatedAt": 1730000000000 }
 *
 * 一致性：Workers KV 是最终一致的，全局最长 60 秒可见。因此
 * `decide()` 只在**明确读到** `mode: "rules"` 且 localpart 不在名单里时
 * 才拒收；任何读取异常都 fail-open 放行 —— 基础设施抖动绝不能变成
 * 用户邮件被静默丢弃。代价是「刚加的 localpart」在传播窗口内可能被
 * 拒收，UI 上有对应的生效提示文案。
 */

import KvConst from '../const/kv-const';
import BizError from '../utils/biz-error';

// 与平台侧 `validateLocalPart`
// (apps/web/app/server/services/email-template-service.ts) 保持同一套
// 规则：平台侧先校验一遍，worker 这里是第二道防线，防止任何绕过平台的
// 写入方往 KV 里塞垃圾。
const LOCAL_PART_REGEX = /^[a-z0-9](?:[a-z0-9](?:[._-][a-z0-9])?)*$/;
const MAX_LOCAL_PART_LENGTH = 64;
// 路由表是「一个域名的收信地址清单」，几十条是常态，上限纯粹是防止
// 有人往单个 KV key 里塞几十万条把 value 撑爆 (KV 单值 25MB 上限)。
const MAX_LOCAL_PARTS = 200;

const MODES = ['catchall', 'rules'];

const routeService = {
	/**
	 * 把域名规整成 key 片段。Cloudflare 给出的收件人地址大小写不固定
	 * (`A@EXAMPLE.COM`)，KV key 必须归一化，否则同一个域名会写出两份
	 * 互相看不见的路由表。
	 */
	normalizeDomain(domain) {
		return String(domain || '').trim().toLowerCase();
	},

	key(domain) {
		const d = this.normalizeDomain(domain);
		if (!d || d.indexOf('@') !== -1) {
			throw new BizError('domain is required');
		}
		return KvConst.ROUTE_RULES + d;
	},

	/**
	 * 读取某个域名的路由表。KV 里没有这个 key 时返回 `null`，
	 * 调用方一律按 `catchall` 处理 —— 「没有配置」和「显式全收」
	 * 在收信行为上完全等价，没必要区分。
	 */
	async get(env, domain) {
		const raw = await env.kv.get(this.key(domain), 'text');
		if (!raw) {
			return null;
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== 'object') {
				return null;
			}
			return {
				domain: this.normalizeDomain(parsed.domain || domain),
				mode: MODES.indexOf(parsed.mode) === -1 ? 'catchall' : parsed.mode,
				localParts: Array.isArray(parsed.localParts)
					? parsed.localParts.filter((p) => typeof p === 'string')
					: [],
				updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
			};
		} catch (e) {
			// 写坏的值不能变成「全部拒收」，按没配置处理。
			console.error('route rules: malformed value for', domain, e);
			return null;
		}
	},

	/**
	 * 写入 / 覆盖某个域名的路由表。`mode` 为 `catchall` 时
	 * `localParts` 会被清空 —— 让 KV 里的值永远自洽，避免出现
	 * `mode: catchall` 却带着一份名单的组合让读侧困惑。
	 */
	async set(env, domain, mode, localParts) {
		const normalizedDomain = this.normalizeDomain(domain);
		if (!normalizedDomain || normalizedDomain.indexOf('@') !== -1) {
			throw new BizError('domain is required');
		}
		if (MODES.indexOf(mode) === -1) {
			throw new BizError('mode must be "catchall" or "rules"');
		}

		let parts = [];
		if (mode === 'rules') {
			if (!Array.isArray(localParts) || localParts.length === 0) {
				throw new BizError('localParts is required in rules mode');
			}
			const seen = new Set();
			for (const raw of localParts) {
				const v = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
				if (v.length === 0 || v.length > MAX_LOCAL_PART_LENGTH || !LOCAL_PART_REGEX.test(v)) {
					throw new BizError('invalid local part: ' + raw);
				}
				seen.add(v);
			}
			parts = Array.from(seen).sort();
			if (parts.length > MAX_LOCAL_PARTS) {
				throw new BizError('too many local parts (max ' + MAX_LOCAL_PARTS + ')');
			}
		}

		const value = {
			domain: normalizedDomain,
			mode: mode,
			localParts: parts,
			updatedAt: Date.now(),
		};
		await env.kv.put(this.key(normalizedDomain), JSON.stringify(value));
		return value;
	},

	/**
	 * 删除某个域名的路由表，回到「全收」状态。幂等：key 不存在也算成功，
	 * 平台侧的 unbind 流程可以放心重试。
	 */
	async clear(env, domain) {
		await env.kv.delete(this.key(domain));
		return { cleared: true };
	},

	/**
	 * 收信热路径：判断 `toAddress` 该不该被接收。
	 *
	 * 必须在 `email-receive.js` 里**先于正文解析**调用 —— 这里是唯一
	 * 一个「便宜地看一眼地址就能决定丢弃」的位置，早退还能省掉大附件
	 * 的 arrayBuffer 读取。
	 *
	 * 返回 `{ action: 'accept' }` 或 `{ action: 'reject', reason }`。
	 * 任何异常都退化成 `accept`（fail-open）。
	 */
	async decide(env, toAddress) {
		try {
			const address = String(toAddress || '').trim().toLowerCase();
			const at = address.lastIndexOf('@');
			if (at <= 0 || at === address.length - 1) {
				// 畸形地址：交给后面原有的流程处理，不在这里误杀。
				return { action: 'accept' };
			}
			const localPart = address.slice(0, at);
			const domain = address.slice(at + 1);

			const rule = await this.get(env, domain);
			if (!rule || rule.mode !== 'rules') {
				return { action: 'accept' };
			}
			if (rule.localParts.indexOf(localPart) !== -1) {
				return { action: 'accept' };
			}
			return { action: 'reject' };
		} catch (e) {
			// KV 抖动 / 隔离异常 —— 绝不能变成用户邮件被丢弃。
			console.error('route rules: decide failed, accepting:', e);
			return { action: 'accept' };
		}
	},
};

export default routeService;
