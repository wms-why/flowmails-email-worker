import PostalMime from 'postal-mime';
import constant from '../const/constant';
import { EmailConst } from '../entity/email';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';
import attService from './att-service';
import emailService from './email-service';
import { getR2Domain } from '../utils/r2-utils';

export async function email(message, env, _ctx) {
	try {
		const email = await PostalMime.parse(message.raw);
		const toName = emailUtils.getName(message.to);
		if (!email.to) {
			email.to = [{ address: message.to, name: toName }];
		}

		const params = {
			toEmail: message.to,
			toName,
			fromEmail: email.from.address,
			fromName: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject || '',
			content: email.html || '',
			text: email.text || '',
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo || '',
			references: email.references || '',
			messageId: email.messageId || '',
			status: EmailConst.status.SAVING,
		};

		const attachments = [];
		const cidAttachments = [];

		for (const item of email.attachments) {
			const attachment = { ...item };
			attachment.key =
				constant.ATTACHMENT_PREFIX + (await fileUtils.getBuffHash(attachment.content)) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		const r2domain = getR2Domain(message.to);

		let emailRow = await emailService.save(env, params, cidAttachments, r2domain);

		attachments.forEach((attachment) => {
			attachment.emailId = emailRow.id;
		});

		if (attachments.length > 0) {
			await attService.insertBatch({ env }, attachments);
		}

		emailRow = await emailService.completeReceive(env, EmailConst.status.RECEIVE, emailRow.id);

		//转发到其他邮箱
		// if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {
		// 	const emails = forwardEmail.split(',');

		// 	await Promise.all(
		// 		emails.map(async (email) => {
		// 			try {
		// 				await message.forward(email);
		// 			} catch (e) {
		// 				console.error(`转发邮箱 ${email} 失败：`, e);
		// 			}
		// 		}),
		// 	);
		// }
	} catch (e) {
		console.error('邮件接收异常: ', e);
	}
}
