import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { eq } from 'drizzle-orm';
import email from '../entity/email';
import orm from '../entity/orm';
import emailHtmlTemplate from '../template/email-html';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import domainUtils from '../utils/domain-uitls';
import jwtUtils from '../utils/jwt-utils';
import settingService from './setting-service';

dayjs.extend(utc);
dayjs.extend(timezone);

const telegramService = {
	async getEmailContent(c, params) {
		const { token } = params;

		const result = await jwtUtils.verifyToken(c, token);

		if (!result) {
			return emailTextTemplate('Access denied');
		}

		const emailRow = await orm(c.env).select().from(email).where(eq(email.id, result.emailId)).get();

		if (emailRow) {
			if (emailRow.content) {
				const host = c.req.header('host') || '';
				return emailHtmlTemplate(emailRow.content || '', host);
			} else {
				return emailTextTemplate(emailRow.text || '');
			}
		} else {
			return emailTextTemplate('The email does not exist');
		}
	},

	async sendEmailToBot(c, email) {
		const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);

		const tgChatIds = tgChatId.split(',');

		const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId });

		const webAppUrl = customDomain
			? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}`
			: 'https://www.cloudflare.com/404';

		await Promise.all(
			tgChatIds.map(async (chatId) => {
				try {
					const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							chat_id: chatId,
							parse_mode: 'HTML',
							text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
							reply_markup: {
								inline_keyboard: [
									[
										{
											text: '查看',
											web_app: { url: webAppUrl },
										},
									],
								],
							},
						}),
					});
					if (!res.ok) {
						console.error(`转发 Telegram 失败: chatId=${chatId}, 状态码=${res.status}`);
					}
				} catch (e) {
					console.error(`转发 Telegram 失败: chatId=${chatId}`, e.message);
				}
			}),
		);
	},
};

export default telegramService;
