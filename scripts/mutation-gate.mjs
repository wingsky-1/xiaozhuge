#!/usr/bin/env node
/**
 * 变异分数聚合门禁（issue #101 P4 引入；#115 扩展 partial 合成口径）。
 *
 * covered 口径对齐 @stryker-mutator/mutation-testing-metrics 的
 * mutationScoreBasedOnCoveredCode：
 *   covered score = Σ totalDetected / Σ totalCovered × 100
 *
 * 为什么聚合而非每段独立 break（issue #101 实测依据）：
 * plugin 目录 total 口径仅 65.68，当前全局分靠 runtime 拉起——按段独立
 * break≥70 会立刻假红；聚合计分保持与既有包级门禁同一语义。
 *
 * 两种运行形态：
 *   full    — 全部段取 reports/mutation/<seg>.json 实跑报告聚合（原行为）；
 *   partial — --ran <seg,...> 指定实跑段；实跑段取新报告，未跑段从仓库内
 *             stryker-incremental-<seg>.json 反推基准分后合成全局。
 *             正确性前提：未跑段的源码与测试均未变更（ci.yml 三档路由保证），
 *             其 mutant 集合与 killed 结果数学上恒定 → 合成结果与全量跑等价
 *             （tests/ 下有等价性单测锁死该性质）。不做「只聚合实跑段」的
 *             弱化口径——存在大权重低分段小幅下滑漏检的理论缝隙。
 *
 * fail-closed 约定不变：任一所需文件缺失 / 解析失败 / 结构异常即 exit 1——
 * 缺证据视为未验证，绝不放行。段间 mutate 区间目录互斥无重叠，直接加权求和
 * 即可（无需 dsh-plugin-hub#220 PR#257 的跨报告 id 去重——那是重叠区的坑）。
 *
 * 用法：node scripts/mutation-gate.mjs [--ran seg1,seg2] [threshold]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONF_DIR = "stryker.conf.d";
const REPORT_DIR = "reports/mutation";
const BASELINE_PREFIX = "stryker-incremental-";
const BREAK_DEFAULT = 70;

/** 从 conf.d 推导段名，保证 CI matrix 与本地入口同源。 */
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

/** 从 mutants 数组按状态计数。status 为 PascalCase（实测与 schema 文档全大写不同）。 */
export function countMutants(mutants) {
  let detected = 0;
  let covered = 0;
  for (const m of mutants) {
    switch (m.status) {
      case "Killed":
      case "Timeout":
        detected += 1;
        covered += 1;
        break;
      case "Survived":
      case "Ignored":
        covered += 1;
        break;
      default:
        // NoCoverage / RuntimeError / CompileError / Pending 不进 covered 口径
        break;
    }
  }
  return { detected, covered };
}

/**
 * 从 {files: {path: {mutants}}} 结构提取计数。
 * json 报告与 incremental 基线同构；返回 null 表示结构异常，由调用方裁决。
 */
export function totalsFromReport(doc) {
  const entries = Object.values(doc.files ?? {});
  if (entries.length === 0) return null;
  let detected = 0;
  let covered = 0;
  for (const entry of entries) {
    if (!Array.isArray(entry.mutants)) return null;
    const c = countMutants(entry.mutants);
    detected += c.detected;
    covered += c.covered;
  }
  return { detected, covered };
}

function bail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    bail(`解析失败 ${path}：${err.message}`);
  }
}

/**
 * 单段计数来源路由：实跑段读 json 报告，未跑段反推 incremental 基线。
 * 返回 {detected, covered, source: "report"|"baseline"}。
 */
export function segmentTotals(seg, ran, dirs = {}) {
  const reportDir = dirs.reportDir ?? REPORT_DIR;
  if (ran.has(seg)) {
    return loadReportSource(seg, reportDir);
  }
  return loadBaselineSource(seg, dirs.root);
}

function loadReportSource(seg, reportDir) {
  const path = join(reportDir, `${seg}.json`);
  if (!existsSync(path)) {
    bail(`段 ${seg} 的报告缺失：${path}（缺任一实跑段报告即不放行）`);
  }
  const totals = totalsFromReport(readJson(path));
  if (totals === null) {
    bail(`段 ${seg} 报告 files 为空或结构异常（mutate 配置漂移？）`);
  }
  return { ...totals, source: "report" };
}

function loadBaselineSource(seg, root) {
  const baselinePath = join(root ?? ".", `${BASELINE_PREFIX}${seg}.json`);
  if (!existsSync(baselinePath)) {
    bail(`段 ${seg} 未实跑且基线缺失：${baselinePath}（合成判分不放行）`);
  }
  const totals = totalsFromReport(readJson(baselinePath));
  if (totals === null) {
    bail(`段 ${seg} 基线 files 为空或结构异常`);
  }
  return { ...totals, source: "baseline" };
}

/**
 * 纯聚合：各段明细 + 全局合成结果（CLI 与等价性单测共用）。
 * @param ran Set<string>|null 实跑段集合；null 视为全部实跑（full 形态）。
 */
export function aggregate(ran = null, dirs = {}) {
  const segments = discoverSegments(dirs.confDir);
  if (segments.length === 0) {
    bail(`${dirs.confDir ?? CONF_DIR} 下没有任何段配置`);
  }
  const ranSet = ran ?? new Set(segments);

  let detected = 0;
  let covered = 0;
  const rows = [];
  for (const seg of segments) {
    const totals = segmentTotals(seg, ranSet, dirs);
    detected += totals.detected;
    covered += totals.covered;
    rows.push({ seg, ...totals });
  }
  const score = covered > 0 ? (detected / covered) * 100 : NaN;
  return { rows, detected, covered, score };
}

function formatScore(detected, covered) {
  return covered > 0 ? ((detected / covered) * 100).toFixed(2) : "n/a";
}

function printRow(label, detected, covered) {
  console.log(
    `  ${label.padEnd(12)} detected=${String(detected).padStart(5)} covered=${String(covered).padStart(5)} score=${formatScore(detected, covered)}`,
  );
}

function parseArgs(argv) {
  const args = { ran: null, threshold: BREAK_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ran") {
      i += 1;
      const raw = argv[i];
      if (!raw) bail("--ran 需要逗号分隔的段清单");
      args.ran = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
    } else {
      const n = Number(argv[i]);
      if (!Number.isFinite(n)) bail(`无法识别的参数：${argv[i]}`);
      args.threshold = n;
    }
  }
  return args;
}

function main() {
  const { ran, threshold } = parseArgs(process.argv.slice(2));
  const result = aggregate(ran);

  console.log("=== 变异分数聚合（covered 口径）===");
  for (const row of result.rows) {
    printRow(`${row.seg}${row.source === "baseline" ? "*" : ""}`, row.detected, row.covered);
  }
  console.log("  (* = 取自入库基线，该段本次无变异面变更)");
  printRow("AGGREGATE", result.detected, result.covered);

  if (!(result.score >= threshold)) {
    bail(`聚合 covered score ${isNaN(result.score) ? "NaN" : result.score.toFixed(2)} 低于阈值 ${threshold}`);
  }
  console.log(`聚合分数 ≥ ${threshold}，门禁通过`);
}

// 仅直接执行时判分；被导入时只提供纯函数（顶层无条件 main 会让导入方提前退出）
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
