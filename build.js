/**
 * Cloudflare Workers 单文件打包脚本
 * 使用 esbuild 将所有代码和依赖打包成单个 JS 文件
 *
 * 输出：
 *   1. apps/email-worker/dist/worker-${version}.js   — 本地归档
 *   2. apps/web/app/server/email-worker/worker.js   — 复制到 web 项目，
 *      由 cloudflare-worker-service.ts 通过 `?raw` import 内联进 server bundle，
 *      最终通过 Cloudflare SDK `workers.scripts.update` 上传到目标账户
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cloudflare Workers 运行时提供的全局变量和模块（需要排除）
const CF_EXTERNALS = [
  // Web API 全局变量
  'fetch',
  'Request',
  'Response',
  'Headers',
  'URL',
  'URLSearchParams',
  'URLPattern',
  'TextEncoder',
  'TextDecoder',
  'crypto',
  'subtle',
  'caches',
  'Cache',
  'CacheStorage',
  'AbortController',
  'AbortSignal',

  // Cloudflare Workers 绑定
  'env',
  'ctx',

  // Cloudflare Workers 模块
  'cloudflare:email',
];

// apps/web 内联此 bundle 时 import 用的稳定路径。
// 不带版本号 —— 版本已经写进 bundle 内了，运行时不需要区分。
const WEB_BUNDLE_RELATIVE_PATH = '../web/app/server/email-worker/worker.js';

async function build() {
  const startTime = Date.now();

  try {
    console.log('🚀 开始打包 Cloudflare Workers 项目...\n');

    // 读取 package.json 获取版本号
    const packageJsonPath = path.join(__dirname, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version || '1.0.0';
    const distDir = path.join(__dirname, 'dist');
    const outputPath = path.join(distDir, `worker-${version}.js`);
    // 确保输出目录存在
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }

    // 执行打包
    const result = await esbuild.build({
      entryPoints: [path.join(__dirname, 'src/index.js')],
      bundle: true,
      outfile: path.join(distDir, `worker-${version}.js`),
      platform: 'browser',
      target: 'es2022', // 现代 Workers 支持 es2022
      format: 'esm', // 直接使用 esm 格式，不要用 iife
      external: CF_EXTERNALS,
      minify: true,
      treeShaking: true,
      keepNames: true,
      metafile: true, // 必须设为 true 才能让 stats.inputs 生效
      define: {
        'process.env.NODE_ENV': '"production"',
      },
      logLevel: 'info',
    });

    // 计算打包结果
    const stats = result.metafile;
    const outputSize = fs.statSync(outputPath).size;
    const outputSizeKB = (outputSize / 1024).toFixed(2);
    const buildTime = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('✅ 打包成功!\n');
    console.log('📦 输出文件:', outputPath);
    console.log('📦 版本号:', version);
    console.log('📊 输出大小:', `${outputSizeKB} KB`);
    console.log('⏱️  打包耗时:', `${buildTime}s`);
    console.log('\n📝 打包统计:');

    if (stats?.inputs) {
      console.log('   输入文件数量:', Object.keys(stats.inputs).length);
    }

    if (stats?.outputs) {
      console.log('   输出文件数量:', Object.keys(stats.outputs).length);
    }

    // 把打包结果复制到 apps/web，让 web 的 server bundle 能通过 ?raw import
    // 把字符串内联进来，最终由 Cloudflare SDK 上传到目标账户。
    const webBundlePath = path.join(__dirname, WEB_BUNDLE_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(webBundlePath), { recursive: true });
    fs.copyFileSync(outputPath, webBundlePath);

    const webBundleSize = (fs.statSync(webBundlePath).size / 1024).toFixed(2);
    console.log('\n📋 已复制到 web 项目:');
    console.log('   ', webBundlePath);
    console.log('   ', `${webBundleSize} KB`);
    console.log('\nℹ️  apps/web 的 prebuild 会在它自己 build 之前调用本脚本，');
    console.log('   ?raw import 会在 server bundle 编译时把该文件作为字符串内联。');

    // Write a sibling version.txt so apps/web can read the latest
    // available email-worker version at request time via a `?raw`
    // import (mirrors the worker.js import in cloudflare-worker-service).
    const versionTxtPath = path.join(path.dirname(webBundlePath), 'version.txt');
    fs.writeFileSync(versionTxtPath, version);
    console.log('   ', `${versionTxtPath} (version.txt = ${version})`);
  } catch (error) {
    console.error('❌ 打包失败:', error.message);

    if (error.errors) {
      console.error('\n详细错误:');
      error.errors.forEach((err, i) => {
        console.error(`  ${i + 1}. ${err.text}`);
        if (err.location) {
          console.error(`     位置: ${err.location.file}:${err.location.line}:${err.location.column}`);
        }
      });
    }

    process.exit(1);
  }
}

build();