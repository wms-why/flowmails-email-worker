# Cloudflare Workers 单文件打包方案

## 项目概述

本项目是一个基于 Cloudflare Workers 的邮件服务，使用 Hono 框架构建。

### 项目结构

```
src/
├── index.js              # 入口文件
├── hono/
│   ├── webs.js           # Hono 应用实例
│   └── hono.js           # Hono 配置
├── api/                  # API 路由
├── service/              # 业务逻辑
├── entity/               # 数据实体
├── utils/                # 工具函数
├── email/                # 邮件处理
├── security/             # 安全相关
└── ...
```

## 打包方案

### 选择工具：esbuild

esbuild 是目前最快的 JavaScript 打包工具，非常适合 Cloudflare Workers 项目。

### 打包策略

```
┌─────────────────────────────────────────────────────────────┐
│                      打包配置                                │
├─────────────────────────────────────────────────────────────┤
│  入口文件: src/index.js                                      │
│  输出文件: dist/worker.js                                    │
│  格式: ESM (ES Module)                                       │
│  目标: ES2020                                                │
│  平台: browser                                               │
├─────────────────────────────────────────────────────────────┤
│  打包内容:                                                   │
│  ✓ 所有源代码 (src/ 目录下所有 .js 文件)                     │
│  ✓ 所有 npm 依赖 (hono, drizzle-orm, aws-sdk 等)            │
├─────────────────────────────────────────────────────────────┤
│  排除内容 (由 Workers 运行时提供):                           │
│  ✗ fetch                                                    │
│  ✗ Request, Response                                        │
│  ✗ URL, URLSearchParams                                     │
│  ✗ TextEncoder, TextDecoder                                 │
│  ✗ crypto (Web Crypto API)                                  │
│  ✗ caches                                                   │
│  ✗ D1 数据库绑定                                             │
│  ✗ KV 命名空间绑定                                           │
│  ✗ R2 存储绑定                                               │
└─────────────────────────────────────────────────────────────┘
```

## 实施步骤

### 1. 安装 esbuild

```bash
pnpm add -D esbuild
```

### 2. 创建打包脚本

创建 `build.js` 脚本：

```javascript
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cloudflare Workers 运行时提供的全局变量
const CF_GLOBALS = [
	'fetch',
	'Request',
	'Response',
	'Headers',
	'URL',
	'URLSearchParams',
	'TextEncoder',
	'TextDecoder',
	'crypto',
	'subtle',
	'caches',
	'Cache',
	'CacheStorage',
];

try {
	// 执行打包
	const result = await esbuild.build({
		entryPoints: [path.join(__dirname, 'src/index.js')],
		bundle: true,
		outfile: path.join(__dirname, 'dist/worker.js'),
		platform: 'browser',
		target: 'es2020',
		format: 'esm',
		external: CF_GLOBALS,
		loader: {
			'.js': 'jsx',
		},
		minify: true,
		treeShaking: true,
		sourcemap: true,
	});

	console.log('✅ 打包成功!');
	console.log(`📦 输出文件: ${path.join(__dirname, 'dist/worker.js')}`);
	console.log(`📊 输出大小: ${(fs.statSync(path.join(__dirname, 'dist/worker.js')).size / 1024).toFixed(2)} KB`);
} catch (error) {
	console.error('❌ 打包失败:', error);
	process.exit(1);
}
```

### 3. 更新 package.json

添加打包脚本命令：

```json
{
	"scripts": {
		"dev": "wrangler dev --config wrangler-dev.toml",
		"build": "node build.js",
		"deploy": "wrangler deploy",
		"start": "wrangler dev"
	}
}
```

## 注意事项

1. **Workers 绑定处理**：项目的 `env` 参数包含 D1、KV、R2 等绑定，这些在打包时无法内嵌，需要在部署时通过 Wrangler 配置。

2. **环境变量**：敏感信息（如 API 密钥）不应打包进代码，应通过 Wrangler secrets 管理。

3. **Sourcemap**：生产环境建议禁用 sourcemap 以减小文件大小。

## 部署流程

```
1. pnpm install          # 安装依赖
2. pnpm build            # 打包成单个 JS 文件
3. pnpm deploy           # 部署到 Cloudflare Workers
```

## 可选：进一步优化

### 压缩输出

可以使用 `terser` 进一步压缩：

```bash
pnpm add -D terser
```

### 代码分割

如果需要更好的缓存策略，可以使用代码分割，但会增加文件数量。

## 替代方案

如果 esbuild 不满足需求，可以考虑：

1. **rollup-plugin-esbuild**：更灵活的打包配置
2. **webpack**：更成熟的生态，但打包速度较慢
