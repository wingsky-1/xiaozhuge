#!/usr/bin/env node
/**
 * 客户端 bundle 构建（对齐 dsh-plugin-hub scripts/build/build-client.ts 的
 * externals 契约外壳机制；本项目独立仓库，内联一份精简实现）。
 *
 * 产物：dist/client.js —— 浏览器端 IIFE，load id = 包名，
 * exports.apply / exports.inject 装配。React 等宿主注入依赖走 external，
 * 由 loader 运行时 require 注入（dsh.client.external 声明）。
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const packageName = pkg.name;
const SRC = join(ROOT, "src", "client", "index.tsx");
const OUTFILE = join(ROOT, "dist", "client.js");

/** 宿主注入 external（dsh.client.external 声明与构建期 external 必须一致）。 */
const EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-ui-conversation",
];

/**
 * 契约外壳：干净模块（cjs，external 依赖经 factory require 注入）内联进
 * factory 函数体——factory 参数名 `require` 遮蔽外部，external 的
 * `require("react")` 解析到 loader 注入值（对齐 dsh-web-ui 模块表机制）。
 */
function renderFactoryContract(name, cleanCjs) {
  const indented = cleanCjs
    .split("\n")
    .map((l) => (l.length ? "    " + l : ""))
    .join("\n");
  return `"use strict";
// 契约外壳（scripts/build-client.mjs 生成）：external 依赖（React 等）经 factory 注入的 require 解析
window.__ModuleLoader__.load({
  id: ${JSON.stringify(name)},
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
${indented}
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module' })
    return module.exports
  }
})
`;
}

const r = await build({
  bundle: true,
  target: "es2020",
  charset: "utf8",
  format: "cjs",
  platform: "browser",
  external: EXTERNALS,
  entryPoints: [SRC],
  jsx: "automatic",
  // css-as-text（issue 68）：宿主 loader 只 load JS，React Flow 样式无法作为
  // 独立 .css 文件交付——把样式当文本打进 bundle，运行时一次性注入 <style>。
  // 经 onLoad 插件按 @xyflow/react 路径精确过滤（全局 '.css' 后缀映射会吞掉
  // 未来一切正常 css 导入），其余 css 导入维持 esbuild 默认行为。
  plugins: [
    {
      name: "css-as-text-xyflow-only",
      setup(build) {
        build.onLoad({ filter: /node_modules[\\/]@xyflow[\\/]react[\\/].*\.css$/ }, async (args) => {
          const text = await import("node:fs/promises").then((fs) => fs.readFile(args.path, "utf8"));
          return { contents: text, loader: "text" };
        });
      },
    },
  ],
  logLevel: "warning",
  write: false,
});

const code = renderFactoryContract(packageName, r.outputFiles[0].text);

// 内建契约校验：load id === 包名；apply/inject 装配在场。
const m = code.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*"([^"]+)"/);
if (!m || m[1] !== packageName) {
  throw new Error(
    `客户端契约校验失败：load id 必须等于包名 ${packageName}（实际: ${m ? m[1] : "缺失"}）`,
  );
}
if (!/apply/.test(code) || !/inject/.test(code)) {
  throw new Error("客户端契约校验失败：产物缺少 exports.apply/exports.inject 装配");
}

writeFileSync(OUTFILE, code);
// 最小类型声明（主 tsconfig 排除 src/client，tsc 不产出 d.ts；手写契约面）。
writeFileSync(
  join(ROOT, "dist", "client.d.ts"),
  `/** 小诸葛浏览器端插件（dsh.client 契约）：由构建脚本生成的最小类型面。 */
export declare const name: string;
export declare const inject: string[];
export declare function apply(ctx: unknown): void;
`,
);
console.log(`[build-client] ${packageName}: client bundle → ${OUTFILE} (${code.length} bytes)`);
