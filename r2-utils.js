/**
 * R2 (Cloudflare Object Storage) 工具类
 * 使用 AWS S3 SDK 操作 R2 存储
 */

import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * R2 配置类
 */
export class R2Config {
	constructor(options = {}) {
		this.accountId = options.accountId || process.env.R2_ACCOUNT_ID;
		this.accessKeyId = options.accessKeyId || process.env.R2_ACCESS_KEY_ID;
		this.secretAccessKey = options.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
		this.bucketName = options.bucketName || process.env.R2_BUCKET_NAME;
		this.publicUrl = options.publicUrl || process.env.R2_PUBLIC_URL; // R2 公开访问 URL（可选）
	}

	/**
	 * 验证配置是否完整
	 */
	validate() {
		const missing = [];
		if (!this.accountId) missing.push('accountId');
		if (!this.accessKeyId) missing.push('accessKeyId');
		if (!this.secretAccessKey) missing.push('secretAccessKey');
		if (!this.bucketName) missing.push('bucketName');

		if (missing.length > 0) {
			throw new Error(`R2 配置缺少必要字段: ${missing.join(', ')}`);
		}
	}
}

/**
 * R2 工具类
 */
export class R2Util {
	/**
	 * 创建 R2 客户端实例
	 * @param {R2Config} config - R2 配置
	 * @returns {S3Client} S3 客户端实例
	 */
	static createClient(config) {
		config.validate();

		// R2 的 endpoint 格式
		const endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;

		return new S3Client({
			region: 'auto',
			endpoint: endpoint,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
		});
	}

	/**
	 * 上传文件到 R2
	 * @param {R2Config} config - R2 配置
	 * @param {string} key - 对象键名（文件路径）
	 * @param {Buffer|Uint8Array|string} body - 文件内容
	 * @param {object} options - 可选配置
	 * @returns {Promise<object>} 上传结果
	 */
	static async upload(config, key, body, options = {}) {
		const client = this.createClient(config);

		const command = new PutObjectCommand({
			Bucket: config.bucketName,
			Key: key,
			Body: body,
			ContentType: options.contentType || 'application/javascript',
			CacheControl: options.cacheControl || 'public, max-age=31536000', // 默认缓存一年
			...options.extraParams,
		});

		await client.send(command);

		return {
			success: true,
			key,
			url: config.publicUrl ? `${config.publicUrl}/${key}` : null,
			bucket: config.bucketName,
		};
	}

	/**
	 * 上传文本内容到 R2
	 * @param {R2Config} config - R2 配置
	 * @param {string} key - 对象键名
	 * @param {string} content - 文本内容
	 * @param {string} contentType - MIME 类型
	 * @returns {Promise<object>} 上传结果
	 */
	static async uploadText(config, key, content, contentType = 'text/plain') {
		return this.upload(config, key, content, { contentType });
	}

	/**
	 * 上传 JSON 文件到 R2
	 * @param {R2Config} config - R2 配置
	 * @param {string} key - 对象键名
	 * @param {object} data - JSON 数据
	 * @returns {Promise<object>} 上传结果
	 */
	static async uploadJson(config, key, data) {
		const content = JSON.stringify(data, null, 2);
		return this.upload(config, key, content, { contentType: 'application/json' });
	}

	/**
	 * 从 R2 下载文件
	 * @param {R2Config} config - R2 配置
	 * @param {string} key - 对象键名
	 * @returns {Promise<Buffer>} 文件内容
	 */
	static async download(config, key) {
		const client = this.createClient(config);

		const command = new GetObjectCommand({
			Bucket: config.bucketName,
			Key: key,
		});

		const response = await client.send(command);
		const chunks = [];

		for await (const chunk of response.Body) {
			chunks.push(chunk);
		}

		return Buffer.concat(chunks);
	}

	/**
	 * 列出 R2 桶中的对象
	 * @param {R2Config} config - R2 配置
	 * @param {string} prefix - 前缀过滤
	 * @param {number} maxKeys - 最大返回数量
	 * @returns {Promise<Array>} 对象列表
	 */
	static async list(config, prefix = '', maxKeys = 1000) {
		const client = this.createClient(config);

		const command = new ListObjectsV2Command({
			Bucket: config.bucketName,
			Prefix: prefix,
			MaxKeys: maxKeys,
		});

		const response = await client.send(command);
		return response.Contents || [];
	}

	/**
	 * 删除 R2 中的对象
	 * @param {R2Config} config - R2 配置
	 * @param {string} key - 对象键名
	 * @returns {Promise<object>} 删除结果
	 */
	static async delete(config, key) {
		const client = this.createClient(config);

		const command = new DeleteObjectCommand({
			Bucket: config.bucketName,
			Key: key,
		});

		await client.send(command);

		return {
			success: true,
			key,
		};
	}

	/**
	 * 检查对象是否存在
	 * @param {R2Config} config - R2 配置
	 * @param {string} key - 对象键名
	 * @returns {Promise<boolean>} 是否存在
	 */
	static async exists(config, key) {
		const client = this.createClient(config);

		try {
			const command = new GetObjectCommand({
				Bucket: config.bucketName,
				Key: key,
			});

			await client.send(command);
			return true;
		} catch (error) {
			if (error.name === 'NoSuchKey') {
				return false;
			}
			throw error;
		}
	}
}

export default R2Util;
