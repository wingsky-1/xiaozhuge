#!/usr/bin/env node
/**
 * scripts/check-mutation-coverage.mjs — Anti-Silent-Drop 防漏测与防重叠硬门禁（#608 工业级沉淀）
 *
 * 核心目标：
 * 自动扫描全仓服务端 TypeScript 业务源码，断言：
 * 每一个业务源文件必须且只能存在于某一个变异分段（stryker.conf.d/*.json）中。
 * - 命中 0 次：漏测（Silent Drop）——下游分母缩小产生假高分，立即阻断；
 * - 命中 >1 次：重合（Duplicate Coverage）——跨段重复运行且可能破坏加权聚合，立即阻断。
 *
 * 用法：
 *   node scripts/check-mutation-coverage.mjs [confDir] [srcDir]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { segmentCovers } from "./mutation-segments.mjs";

const DEFAULT_CONF_DIR = "stryker.conf.d";
const DEFAULT_SRC_DIR = "src";

/** 判断文件是否属于服务端业务变异源码（排除声明文件与客户端 UI 模块）。 */
export function isServerSrcFile(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  if (!norm.startsWith("src/") || norm.endsWith(".d.ts")) {
    return false;
  }
  // 排除客户端 UI 模块（由独立测试与验证套件覆盖）
  if (norm.startsWith("src/client/")) {
    return false;
  }
  return norm.endsWith(".ts") || norm.endsWith(".tsx");
}

/** 递归扫描目录下所有文件（返回相对于 rootDir 的路径）。 */
export function scanFiles(dir, rootDir = process.cwd()) {
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanFiles(full, rootDir));
      } else if (entry.isFile()) {
        const rel = relative(rootDir, full).replace(/\\/g, "/");
        results.push(rel);
      }
    }
  } catch {
    return [];
  }
  return results;
}

/** 读取并解析段配置列表。 */
export function loadSegmentConfigs(resolvedConf) {
  let segFiles;
  try {
    segFiles = readdirSync(resolvedConf).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    return { error: `读取配置目录失败 ${resolvedConf}：${err.message}`, segments: [] };
  }

  if (segFiles.length === 0) {
    return { error: `配置目录 ${resolvedConf} 下没有任何分段配置文件`, segments: [] };
  }

  const segments = [];
  for (const f of segFiles) {
    const segName = f.replace(/\.json$/, "");
    try {
      const conf = JSON.parse(readFileSync(join(resolvedConf, f), "utf8"));
      if (!Array.isArray(conf.mutate)) {
        return { error: `段配置 ${f} 缺少 mutate 数组`, segments: [] };
      }
      segments.push({ name: segName, mutate: conf.mutate });
    } catch (err) {
      return { error: `解析段配置 ${f} 失败：${err.message}`, segments: [] };
    }
  }
  return { error: null, segments };
}

/** 评估源文件在各段中的命中覆盖情况。 */
export function evaluateCoverage(targetFiles, segments) {
  const uncovered = [];
  const duplicated = {};

  for (const file of targetFiles) {
    const hits = [];
    for (const seg of segments) {
      if (segmentCovers(seg.mutate, file)) {
        hits.push(seg.name);
      }
    }
    if (hits.length === 0) {
      uncovered.push(file);
    } else if (hits.length > 1) {
      duplicated[file] = hits;
    }
  }
  return { uncovered, duplicated };
}

/** 校验全部服务端源码在变异分段中的覆盖情况。 */
export function checkMutationCoverage(confDir = DEFAULT_CONF_DIR, srcDir = DEFAULT_SRC_DIR, rootDir = process.cwd()) {
  const resolvedSrc = resolve(rootDir, srcDir);
  const resolvedConf = resolve(rootDir, confDir);
  const allFiles = scanFiles(resolvedSrc, rootDir);
  const targetFiles = allFiles.filter(isServerSrcFile).sort();

  if (targetFiles.length === 0) {
    return {
      ok: false,
      error: `在 ${srcDir} 下未找到任何需变异测试的服务端业务源文件`,
      targetFiles: [],
      uncovered: [],
      duplicated: {},
    };
  }

  const { error, segments } = loadSegmentConfigs(resolvedConf);
  if (error) {
    return {
      ok: false,
      error,
      targetFiles,
      uncovered: targetFiles,
      duplicated: {},
    };
  }

  const { uncovered, duplicated } = evaluateCoverage(targetFiles, segments);
  const ok = uncovered.length === 0 && Object.keys(duplicated).length === 0;
  return { ok, targetFiles, segments: segments.map((s) => s.name), uncovered, duplicated };
}

function main() {
  const confDir = process.argv[2] || DEFAULT_CONF_DIR;
  const srcDir = process.argv[3] || DEFAULT_SRC_DIR;

  console.log(`=== Anti-Silent-Drop 变异源文件覆盖校验 (${confDir} vs ${srcDir}) ===`);
  const result = checkMutationCoverage(confDir, srcDir);

  if (!result.ok && result.error) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }

  console.log(`待覆盖服务端业务源文件数：${result.targetFiles.length}`);
  console.log(`已配置变异分段清单：${result.segments.join(", ")}`);

  let failed = false;
  if (result.uncovered.length > 0) {
    failed = true;
    console.error(
      `::error::[Anti-Silent-Drop] 以下 ${result.uncovered.length} 个服务端源文件未被任何变异段覆盖 (漏测导致的假高分风险)：\n  - ${result.uncovered.join("\n  - ")}`,
    );
  }

  const dupEntries = Object.entries(result.duplicated);
  if (dupEntries.length > 0) {
    failed = true;
    console.error(
      `::error::[Anti-Silent-Drop] 以下 ${dupEntries.length} 个源文件被多个分段重复覆盖 (重合冲突)：\n` +
        dupEntries.map(([file, segs]) => `  - ${file} -> [${segs.join(", ")}]`).join("\n"),
    );
  }

  if (failed) {
    console.error("::error::[Anti-Silent-Drop] 门禁未通过，请调整 stryker.conf.d/*.json 确保每个源文件唯一归属一个分段。");
    process.exit(1);
  }

  console.log(`✓ [Anti-Silent-Drop] 校验通过：全部 ${result.targetFiles.length} 份服务端业务源码已 100% 互斥覆盖（无漏测、无重合）。`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
