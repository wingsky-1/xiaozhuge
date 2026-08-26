#!/usr/bin/env node
/**
 * 跨段变异分数聚合门禁（issue #101 P4）。
 *
 * 读取各段的 Stryker JSON 报告，按 covered 口径聚合后与阈值比较：
 *   covered score = Σ totalDetected / Σ totalCovered × 100
 * 口径对齐 @stryker-mutator/mutation-testing-metrics 的
 * mutationScoreBasedOnCoveredCode 定义，与全量时代的全局 covered 分数可比。
 *
 * 为什么聚合而非每段独立 break（issue #101 实测依据）：
 * plugin 目录 total 口径仅 65.68，当前全局分靠 runtime 拉起——按段独立
 * break≥70 会立刻假红；聚合计分保持与既有包级门禁同一语义。
 *
 * fail-closed 约定：任一段报告缺失 / JSON 解析失败 / metrics 结构异常，
 * 一律 exit 1——缺报告视为未验证，绝不放行。段间 mutate 区间按目录互斥，
 * 不存在跨报告 mutant 重叠，故直接加权求和即可（无需 dsh-plugin-hub#220
 * PR#257 那类跨报告 id 去重——那是重叠区场景的坑）。
 *
 * 用法：node scripts/mutation-gate.mjs [threshold]
 *   threshold 默认 70；段列表由 stryker.conf.d/*.json 推导。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONF_DIR = "stryker.conf.d";
const REPORT_DIR = "reports/mutation";
const BREAK_DEFAULT = 70;

/** 从 conf.d 推导段名（文件名去扩展名），保证 CI matrix 与本地口径同源。 */
export function discoverSegments() {
  return readdirSync(CONF_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/** fail-closed 的统一失败出口。 */
function bail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function parseSegmentReport(seg) {
  const path = join(REPORT_DIR, `${seg}.json`);
  if (!existsSync(path)) {
    bail(`段 ${seg} 的报告缺失：${path}（缺任一段报告即不放行）`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    bail(`段 ${seg} 报告解析失败：${err.message}`);
  }
}

/**
 * 从报告的 mutants 数组按状态计数，口径严格对齐
 * @stryker-mutator/mutation-testing-metrics 的 Metrics 定义：
 *   totalDetected = killed + timeout
 *   totalCovered  = totalDetected + survived + ignored
 * （json 报告不含预计算 metrics——files[path] 只有原始 mutants 数组，
 * metrics 是 mutation-testing-metrics 在展示层计算的。）
 */
function countMutants(seg, entry) {
  const counts = { detected: 0, covered: 0 };
  for (const mutant of entry.mutants ?? []) {
    switch (mutant.status) {
      // Stryker json 报告的 status 为 PascalCase（实测：Killed/Survived/
      // NoCoverage/Timeout），与 report schema 文档的全大写枚举不同
      case "Killed":
      case "Timeout":
        counts.detected += 1;
        counts.covered += 1;
        break;
      case "Survived":
      case "Ignored":
        counts.covered += 1;
        break;
      default:
        // NoCoverage / RuntimeError / CompileError / Pending 不进 covered 口径
        break;
    }
  }
  return counts;
}

function segmentTotals(seg) {
  const report = parseSegmentReport(seg);
  const entries = Object.values(report.files ?? {});
  // files 为空说明该段没有可变异文件——配置漂移信号，同样 fail-closed
  if (entries.length === 0) {
    bail(`段 ${seg} 报告 files 为空（mutate 配置漂移？）`);
  }
  let detected = 0;
  let covered = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry.mutants)) {
      bail(`段 ${seg} 报告 files 条目缺 mutants 数组`);
    }
    const counts = countMutants(seg, entry);
    detected += counts.detected;
    covered += counts.covered;
  }
  return { detected, covered };
}

function formatScore(detected, covered) {
  return covered > 0 ? ((detected / covered) * 100).toFixed(2) : "n/a";
}

function printRow(label, detected, covered) {
  console.log(
    `  ${label.padEnd(12)} detected=${String(detected).padStart(5)} covered=${String(covered).padStart(5)} score=${formatScore(detected, covered)}`,
  );
}

function main() {
  const threshold = Number(process.argv[2] ?? process.env.MUTATION_BREAK ?? BREAK_DEFAULT);
  const segments = discoverSegments();
  if (segments.length === 0) {
    bail(`${CONF_DIR} 下没有任何段配置`);
  }

  let detected = 0;
  let covered = 0;
  for (const seg of segments) {
    const totals = segmentTotals(seg);
    detected += totals.detected;
    covered += totals.covered;
    printRow(seg, totals.detected, totals.covered);
  }

  const aggregated = covered > 0 ? (detected / covered) * 100 : NaN;
  console.log("=== 变异分数聚合（covered 口径）===");
  printRow("AGGREGATE", detected, covered);

  if (!(aggregated >= threshold)) {
    bail(`聚合 covered score ${isNaN(aggregated) ? "NaN" : aggregated.toFixed(2)} 低于阈值 ${threshold}`);
  }
  console.log(`聚合分数 ≥ ${threshold}，门禁通过`);
}

// 仅直接执行时判分；被 mutation-all.mjs 等导入时只提供 discoverSegments
// （顶层无条件 main() 会让导入方在自身逻辑前就退出——实证踩过）。
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
