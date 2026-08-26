#!/usr/bin/env node
/**
 * 校验 stryker-incremental.json 与提交基线是否内容一致（--normalize 时
 * 兼作 CI 归档规范化工具，见 baseline.yml）。
 *
 * 两种模式共用一套语义规范：
 * 1. 对象键递归排序（Stryker 键序不稳定）；
 * 2. 每个文件的 mutants 列表按「身份集合」语义比较——签名只保留稳定身份
 *    指纹（mutatorName / replacement / static / location.start），剥离一切
 *    跨运行非确定字段：status / statusReason（增量模式结果会翻转，分数由
 *    thresholds.break 门禁保障）、killedBy / testsCompleted / coveredBy
 *    （测试执行顺序与 id 编号漂移）、id（生成顺序相关）、location.end
 *    （列宽漂移）。tests / testFiles 数组同理置空后不参与比较。
 *
 * ⚠ 归档写回约束（实证教训，勿再"优化"掉）：
 * --normalize 写回的是**最小干预**版（只删 projectRoot、稳定键序），
 * 必须原样保留 id、完整 location（start+end）、coveredBy/killedBy/status、
 * tests/testFiles 数组与 mutants 原始顺序——它们全是 Stryker 增量复用的
 * 输入：differ 按 `${file}@start-end\nmutator: replacement}` 匹配并依赖
 * coveredBy/killedBy 计算测试覆盖差异；剥 end 直接崩（`Cannot destructure
 * property 'line'`），排序/剥 id 或清空 tests 会使复用失效退化为全量重跑。
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

// 段式增量基线（issue #101 P4）：stryker-incremental-<seg>.json，
// 与 stryker.conf.d/ 段配置一一对应；旧单文件 stryker-incremental.json 已退役。
const BASELINE_DIR = ".";
const BASELINE_PREFIX = "stryker-incremental-";

function baselineFiles() {
  return readdirSync(BASELINE_DIR)
    .filter((f) => f.startsWith(BASELINE_PREFIX) && f.endsWith(".json"))
    .sort();
}

/** 递归排序对象键；数组保持原序。 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortDeep(v)]),
    );
  }
  return value;
}

/**
 * 语义比较用的 mutant 身份签名：剥执行结果字段（status/statusReason/
 * killedBy/testsCompleted/coveredBy——增量模式会翻转，分数由门禁保障）
 * 与 id（生成顺序相关）、location.end（列宽漂移）。
 */
function mutantSignature(mutant) {
  const { status, statusReason, killedBy, testsCompleted, coveredBy, id, location, ...rest } = mutant;
  void status; void statusReason; void killedBy; void testsCompleted; void coveredBy; void id;
  const stableLocation = location ? { start: location.start } : undefined;
  return JSON.stringify(sortDeep({ ...rest, location: stableLocation }));
}

/** 规范化为对象树：最小干预（删 projectRoot、稳定键序），结构全保留。 */
function normalizedObject(text) {
  const parsed = JSON.parse(text);
  delete parsed.projectRoot;
  return sortDeep(parsed);
}

function canonical(text) {
  const normalized = normalizedObject(text);
  if (normalized.tests !== undefined) normalized.tests = [];
  if (normalized.testFiles !== undefined) normalized.testFiles = [];
  if (normalized.files) {
    for (const file of Object.keys(normalized.files)) {
      const entry = normalized.files[file];
      if (Array.isArray(entry.mutants)) {
        entry.mutants = entry.mutants.map(mutantSignature).sort();
      }
    }
  }
  return JSON.stringify(normalized, null, 2);
}

if (process.argv[2] === "--normalize") {
  // CI 归档用：最小干预规范化写回。二次执行幂等（键序已稳定、无字段增删）。
  for (const file of baselineFiles()) {
    writeFileSync(
      file,
      JSON.stringify(normalizedObject(readFileSync(file, "utf8")), null, 2) + "\n",
    );
    console.log(`${file} 已规范化写回`);
  }
  process.exit(0);
}

let failed = false;
for (const file of baselineFiles()) {
  if (!existsSync(file)) continue;
  const current = canonical(readFileSync(file, "utf8"));
  const head = execSync(`git show HEAD:${file}`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (current !== canonical(head)) {
    failed = true;
    console.error(
      `::error::${file} 与提交基线不一致（内容级差异）。` +
        "请本地运行 pnpm mutation 后将更新后的基线一并提交。",
    );
  } else {
    console.log(`${file} 基线一致（键序/mutant 序无关比较通过）`);
  }
}
if (failed) process.exit(1);
