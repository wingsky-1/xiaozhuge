#!/usr/bin/env node
/**
 * 变动段推导（issue #115）：输入变更文件清单，输出三档路由判定。
 *
 * 三档语义（业界 TIA 惯例：影响面归约 + 置信不足回退全量，参照 CircleCI TIA /
 * Nx affected）：
 *   skip    — 变更不触及变异面也不触及全量触发集（docs-only 等），整体跳过；
 *   partial — 仅 src 源码变更：mutant 身份只随所属源文件变化（StrykerJS 官方
 *             incremental 语义），只跑命中段；
 *   full    — tests/prompts/配置/lockfile 等变更：Vitest 下测试变化追踪仅
 *             文件级粒度（官方 runner 能力表），置信不足回退全段。
 *
 * 用法：node scripts/mutation-segments.mjs <changed-files.txt>
 *   清单每行一个仓库相对路径；stdout 输出 {"mode","segments"} JSON。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CONF_DIR = "stryker.conf.d";

/** 全量回退触发集：测试/运行时数据/门禁链路自身变化影响所有段的 mutant 判定。 */
export const FULL_RERUN_PATTERNS = [
  /^tests\//,
  /^prompts\//,
  /^stryker\.conf\.d\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig.*\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
  // 门禁链路自身变更后需全量验证
  /^scripts\/mutation-(gate|all|segments)\.mjs$/,
];

/** 变异面文件谓词（与段配置并集口径一致：TS 源码，排除声明文件）。 */
function isSrcFile(file) {
  return file.startsWith("src/") && file.endsWith(".ts") && !file.endsWith(".d.ts");
}

/** 从 conf.d 推导段名，保证与 gate/all 入口同源。 */
export function discoverSegments(confDir = CONF_DIR) {
  try {
    return readdirSync(confDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * glob 形态仅两种（与段配置实际用法一致）：目录递归通配（dir 前缀 + 任意深度
 * + 扩展名，含 ! 排除）、精确路径。
 */
export function compileGlob(g) {
  const neg = g.startsWith("!");
  const pat = neg ? g.slice(1) : g;
  if (pat.includes("/**")) {
    const [prefix, suffix] = pat.split("/**/*.");
    return { neg, test: (p) => p.startsWith(prefix + "/") && p.endsWith("." + suffix) };
  }
  return { neg, test: (p) => p === pat };
}

/** 单段 mutate glob 是否覆盖给定文件（include 后应用 exclude）。 */
export function segmentCovers(patterns, file) {
  let ok = false;
  for (const raw of patterns) {
    const rule = compileGlob(raw);
    if (rule.neg) {
      if (rule.test(file)) ok = false;
    } else if (rule.test(file)) {
      ok = true;
    }
  }
  return ok;
}

/** 读段配置的 mutate patterns；失败返回 null 由调用方 fail-safe。 */
function loadMutatePatterns(seg, confDir) {
  try {
    return JSON.parse(readFileSync(join(confDir, `${seg}.json`), "utf8")).mutate;
  } catch {
    return null;
  }
}

/** 归类变更文件：是否触及全量触发集、src 源码清单。 */
function classifyChanged(changedFiles) {
  let hitsFull = false;
  const srcFiles = [];
  for (const f of changedFiles) {
    if (FULL_RERUN_PATTERNS.some((re) => re.test(f))) {
      hitsFull = true;
    }
    if (isSrcFile(f)) {
      srcFiles.push(f);
    }
  }
  return { hitsFull, srcFiles };
}

/** 匹配 src 变更命中的段；配置读取失败返回 null（配置漂移信号）。 */
function matchSegmentsFor(srcFiles, segments, confDir) {
  const hit = [];
  for (const seg of segments) {
    const patterns = loadMutatePatterns(seg, confDir);
    if (patterns === null) return null;
    if (srcFiles.some((f) => segmentCovers(patterns, f))) {
      hit.push(seg);
    }
  }
  return hit;
}

/**
 * 主推导：changedFiles（仓库相对路径数组）→ {mode, segments}。
 * 分类优先级：full > skip > partial。
 * fail-safe：有 src 变更却无段命中 = 配置漂移，回退 full（宁可多跑不漏检）；
 *            段配置读取失败同理回退 full。
 */
export function resolveRoute(changedFiles, segments, confDir = CONF_DIR) {
  const { hitsFull, srcFiles } = classifyChanged(changedFiles);

  if (hitsFull || (srcFiles.length > 0 && segments.length === 0)) {
    return { mode: "full", segments };
  }
  if (srcFiles.length === 0) {
    return { mode: "skip", segments: [] };
  }

  const hit = matchSegmentsFor(srcFiles, segments, confDir);
  if (hit === null || hit.length === 0) return { mode: "full", segments };
  return { mode: "partial", segments: hit };
}

function main() {
  if (process.argv[2] === "--all") {
    // fail-safe 分支：diff 基线不可得（新分支首次 push 等），一律全量
    console.log(JSON.stringify({ mode: "full", segments: discoverSegments() }));
    return;
  }
  const listFile = process.argv[2];
  if (!listFile) {
    console.error("usage: node scripts/mutation-segments.mjs <changed-files.txt> | --all");
    process.exit(1);
  }
  const changedFiles = readFileSync(listFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  console.log(JSON.stringify(resolveRoute(changedFiles, discoverSegments())));
}

// 仅直接执行时推导；被测试/工具导入时只提供纯函数
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
