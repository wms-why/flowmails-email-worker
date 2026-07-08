const r2Service = {
	async putObj(env, key, content, metadata) {
		if (env.r2) {
			await env.r2.put(key, content, {
				httpMetadata: { ...metadata },
			});
		}
	},

	async getObj(env, key) {
		return await env.r2.get(key);
	},

	async delete(env, key) {
		if (env.r2) {
			await env.r2.delete(key);
		}
	},
};
export default r2Service;
