import { and, eq, isNull, inArray, desc } from 'drizzle-orm';
import { parseHTML } from 'linkedom';
import constant from '../const/constant';
import { attach } from '../entity/att';
import orm from '../entity/orm';
import fileUtils from '../utils/file-utils';
import r2Service from './r2-service';

const attService = {
	async insertBatch(c, attachments) {
		for (const attachment of attachments) {
			const metadate = {
				contentType: attachment.mimeType,
			};

			if (!attachment.contentId) {
				metadate.contentDisposition = `attachment;filename=${attachment.filename}`;
			} else {
				metadate.contentDisposition = `inline;filename=${attachment.filename}`;
				metadate.cacheControl = `max-age=259200`;
			}

			await r2Service.putObj(c.env, attachment.key, attachment.content, metadate);
		}

		await orm(c.env)
			.insert(attach)
			.values(attachments.map((a) => ({ ...a, type: 'att' })))
			.run();
	},

	async list(c, params) {
		const { emailId } = params;

		return orm(c.env)
			.select()
			.from(attach)
			.where(and(eq(attach.emailId, emailId), eq(attach.type, 'att'), isNull(attach.contentId)))
			.all();
	},

	async toImageUrlHtml(c, content, r2domain) {
		const { document } = parseHTML(content);
		const images = Array.from(document.querySelectorAll('img'));

		let imageDataList = [];

		for (const img of images) {
			//邮件正文base64图片转附件
			const src = img.getAttribute('src');
			if (src && src.startsWith('data:image')) {
				const file = fileUtils.base64ToFile(src);
				const buff = await file.arrayBuffer();
				const key = constant.ATTACHMENT_PREFIX + (await fileUtils.getBuffHash(buff)) + fileUtils.getExtFileName(file.name);

				img.setAttribute('src', `https://${r2domain}/${key}`);

				const attData = {};
				attData.key = key;
				attData.filename = file.name;
				attData.mimeType = file.type;
				attData.size = file.size;
				attData.buff = buff;
				attData.content = fileUtils.base64ToDataStr(src);
				attData.contentId = null;

				imageDataList.push(attData);
			}

			//邮件正文站内图片转附件
			if (src && (src.startsWith('/oss/') || (src.startsWith('https://') && src.includes('/api/oss/')))) {
				const key = src.split('/api/oss/')[1] || src.split('/oss/')[1];
				if (key) {
					img.setAttribute('src', `https://${r2domain}/${key}`);

					const attData = {};
					attData.key = key;
					attData.path = src;
					attData.contentId = null;
					attData.type = 'embed';
					imageDataList.push(attData);
				}
			}

			const hasInlineWidth = img.hasAttribute('width');
			const style = img.getAttribute('style') || '';
			const hasStyleWidth = /(^|\s)width\s*:\s*[^;]+/.test(style);

			if (!hasInlineWidth && !hasStyleWidth) {
				const newStyle = `${style ? `${style.trim().replace(/;$/, '')}; ` : ''}max-width: 100%;`;
				img.setAttribute('style', newStyle);
			}
		}

		//查询已有内嵌url图片信息
		const keys = [...new Set(imageDataList.filter((item) => item.path).map((item) => item.key))];
		const dbImageList = await this.selectOneByKeys(c, keys);

		//设置给当前附件
		imageDataList.forEach((image) => {
			dbImageList.forEach((dbImage) => {
				if (image.path && image.key === dbImage.key) {
					image.size = dbImage.size;
					image.filename = dbImage.filename;
					image.mimeType = dbImage.mimeType;
					image.contentType = dbImage.mimeType;
				}
			});
		});

		imageDataList = imageDataList.filter((image) => !image.path || image.size);

		return { imageDataList, html: document.toString() };
	},

	async saveSendAtt(c, attList, emailId) {
		const attDataList = [];

		for (const att of attList) {
			att.buff = fileUtils.base64ToUint8Array(att.content);
			att.key = constant.ATTACHMENT_PREFIX + (await fileUtils.getBuffHash(att.buff)) + fileUtils.getExtFileName(att.filename);
			const attData = { emailId };
			attData.key = att.key;
			attData.size = att.buff.length;
			attData.filename = att.filename;
			attData.mimeType = att.type;
			attData.type = 'att';
			attDataList.push(attData);
		}

		await orm(c.env).insert(attach).values(attDataList).run();

		for (const att of attList) {
			await r2Service.putObj(c.env, att.key, att.buff, {
				contentType: att.type,
				contentDisposition: `attachment;filename=${att.filename}`,
			});
		}
	},

	async saveArticleAtt(c, attDataList, emailId) {
		for (const attData of attDataList) {
			attData.emailId = emailId;
			attData.type = 'embed';
			await r2Service.putObj(c.env, attData.key, attData.buff, {
				contentType: attData.mimeType,
				cacheControl: `max-age=259200`,
				contentDisposition: `inline;filename=${attData.filename}`,
			});
		}

		await orm(c.env).insert(attach).values(attDataList).run();
	},

	async removeByEmailIds(c, emailIds) {
		await this.removeAttByField(c, 'email_id', emailIds);
	},

	// 1.2.0 — symmetric to `removeByEmailIds` but filters on
	// `junk_email_id`. Used by `emailService.deleteJunk` to
	// cascade attachments + their R2 objects when the user
	// purges a junk row (or a bulk of them). Lives on the same
	// `attachments` table as live-email attachments — see
	// migration 1.2.0 for the schema rationale.
	async removeByJunkEmailIds(c, junkEmailIds) {
		await this.removeAttByField(c, 'junk_email_id', junkEmailIds);
	},

	selectByEmailIds(c, emailIds) {
		return orm(c.env)
			.select()
			.from(attach)
			.where(and(inArray(attach.emailId, emailIds), eq(attach.type, 'att')))
			.all();
	},

	async removeAttByField(c, fieldName, fieldValues) {
		const sqlList = [];

		fieldValues.forEach((value) => {
			sqlList.push(
				c.env.db
					.prepare(
						`SELECT a.key, a.id
						FROM attachments a
							   JOIN (SELECT key
									 FROM attachments
									 GROUP BY key
									 HAVING COUNT (*) = 1) t
									ON a.key = t.key
						WHERE a.${fieldName} = ?;`,
					)
					.bind(value),
			);

			sqlList.push(c.env.db.prepare(`DELETE FROM attachments WHERE ${fieldName} = ?`).bind(value));
		});

		const attListResult = await c.env.db.batch(sqlList);

		const delKeyList = attListResult.flatMap((r) => (r.results ? r.results.map((row) => row.key) : []));

		if (delKeyList.length > 0) {
			await this.batchDelete(c, delKeyList);
		}
	},

	async batchDelete(c, keys) {
		if (!keys.length) return;

		const BATCH_SIZE = 1000;

		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batch = keys.slice(i, i + BATCH_SIZE);
			await r2Service.delete(c.env, batch);
		}
	},

	async selectOneByKeys(c, keys) {
		if (!keys || keys.length === 0) {
			return [];
		}
		return orm(c.env).select().from(attach).where(inArray(attach.key, keys)).orderBy(desc(attach.id)).groupBy(attach.key).all();
	},
};

export default attService;
