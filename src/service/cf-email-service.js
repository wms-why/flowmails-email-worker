/**
 * 使用 Cloudflare Email Service 发送邮件
 *
 * 走的是 `SendEmail.send()` 的 builder 重载 (而不是 `new EmailMessage(...)`),
 * 原因:
 * - `EmailMessage` 实例上的 `from` / `to` 都是 `readonly`,任何后续赋值都会抛
 *   "Cannot assign to read only property 'to'..." (cf-email-service.js 历史 bug)。
 * - 构造器重载只支持单个 envelope 收件人,builder 重载原生支持
 *   `to` / `cc` / `bcc` 数组、`replyTo`、`headers`、`attachments`。
 */

const cfEmailService = {
	/**
	 * 发送邮件
	 * @param {object} env - Cloudflare Worker env (需要绑定 EMAIL)
	 * @param {object} params - 邮件参数
	 * @param {string|string[]} params.to - 收件人
	 * @param {string} params.from - 发件人地址 (必须是配置了 Email Routing 的域名)
	 * @param {string} [params.fromName] - 发件人名称
	 * @param {string} params.subject - 主题
	 * @param {string} [params.text] - 纯文本内容
	 * @param {string} [params.html] - HTML 内容
	 * @param {string|string[]} [params.cc] - 抄送
	 * @param {string|string[]} [params.bcc] - 密送
	 * @param {string|string[]} [params.replyTo] - 回复地址
	 * @param {Array} [params.attachments] - 附件 [{filename, contentType|mimeType, content (base64)}]
	 * @param {object} [params.headers] - 额外头信息 (e.g. in-reply-to, references)
	 * @returns {Promise<{data: {id: string} | null, error: {message: string} | null}>}
	 */
	async send(env, params) {
		const { to, from, fromName, subject, text, html, cc, bcc, replyTo, attachments, headers } = params;

		if (!from) {
			return { data: null, error: { message: 'from address is required' } };
		}

		const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
		if (recipients.length === 0) {
			return { data: null, error: { message: 'at least one recipient is required' } };
		}

		try {
			const message = {
				from: fromName ? { name: fromName, email: from } : from,
				to: recipients,
				subject: subject || '',
			};
			if (cc && cc.length > 0) {
				message.cc = Array.isArray(cc) ? cc : [cc];
			}
			if (bcc && bcc.length > 0) {
				message.bcc = Array.isArray(bcc) ? bcc : [bcc];
			}
			if (replyTo) {
				const replyToAddr = Array.isArray(replyTo) ? replyTo[0] : replyTo;
				if (replyToAddr) message.replyTo = replyToAddr;
			}
			if (text) message.text = text;
			if (html) message.html = html;
			if (headers) message.headers = headers;
			if (attachments && attachments.length > 0) {
				message.attachments = attachments.map((a) => ({
					disposition: 'attachment',
					filename: a.filename || 'attachment',
					type: a.contentType || a.mimeType || 'application/octet-stream',
					content: a.content || '',
				}));
			}

			const result = await env.EMAIL.send(message);

			// Cloudflare 返回的 messageId 形如 `<…@email.example.com>`,剥掉尖括号以匹配调用方期望。
			const messageId = (result && result.messageId) ? result.messageId.replace(/^<|>$/g, '') : '';

			return { data: { id: messageId }, error: null };
		} catch (err) {
			return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
		}
	},
};

export default cfEmailService;
