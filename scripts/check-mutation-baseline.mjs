#!/usr/bin/env node
/**
 * 校验 stryker-incremental.json 与提交基线是否内容一致。
 * 两层规范化后比较：
 * 1. 对象键递归排序（Stryker 键序不稳定）；
 * 2. 每个文件的 mutants 列表按「身份集合」语义比较——只保留稳定身份指纹
 *    （mutatorName / replacement / static / location.start），剥离一切跨
 *    运行非确定字段：id / killedBy / testsCompleted / coveredBy /
 *    statusReason（测试执行顺序与 id 编号漂移）、status（增量模式
 *    NoCoverage/Killed/Survived 会翻转，变异分数由 thresholds.break 门禁
 *    保障，基线校验只管 mutant 集合是否一致）、location.end（增量产物
 *    列宽漂移）。
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "stryker-incremental.json";

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
 * 剥离单个 mutant 的运行期噪声，返回**结构保持的规范化对象**（幂等：
 * 对已剥离对象再次应用结果不变）。保留 mutatorName / replacement /
 * static / location.start 作为稳定身份。
 */
function stripMutant(mutant) {
  const { id, killedBy, testsCompleted, coveredBy, statusReason, status, location, ...rest } = mutant;
  void id; void killedBy; void testsCompleted; void coveredBy; void statusReason; void status;
  const stableLocation = location ? { start: location.start } : undefined;
  return sortDeep({ ...rest, location: stableLocation });
}

/** 解析并规范化为对象树：剥环境噪声字段、mutants 换成排序后的身份对象。 */
function normalizedObject(text) {
  const parsed = JSON.parse(text);
  // projectRoot 是生成环境相关的绝对路径（本地/CI 各不同），不参与一致性比较
  delete parsed.projectRoot;
  // tests 段是「测试索引 -> 名称」的运行期映射，id 编号随执行顺序漂移，
  // 不参与一致性比较；mutant 的 coveredBy/killedBy 已在剥离中去除。
  if (parsed.tests !== undefined) parsed.tests = [];
  if (parsed.testFiles !== undefined) parsed.testFiles = [];
  const normalized = sortDeep(parsed);
  if (normalized.files) {
    for (const file of Object.keys(normalized.files)) {
      const entry = normalized.files[file];
      if (Array.isArray(entry.mutants)) {
        entry.mutants = entry.mutants
          .map(stripMutant)
          .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      }
    }
  }
  return normalized;
}

function canonical(text) {
  const normalized = normalizedObject(text);
  if (normalized.files) {
    for (const file of Object.keys(normalized.files)) {
      const entry = normalized.files[file];
      if (Array.isArray(entry.mutants)) {
        entry.mutants = entry.mutants.map((m) => JSON.stringify(m)).sort();
      }
    }
  }
  return JSON.stringify(normalized, null, 2);
}

const current = canonical(readFileSync(FILE, "utf8"));

// --normalize：把**结构保持的**规范化结果写回文件（CI 基线归档用）——
// 保留 mutant 对象形态（只剥运行期噪声、稳定键序），快照 PR 的 git diff
// 只含真实变异体身份变化，且二次执行幂等。
// 注意：不能写回 canonical() 输出——那是签名串数组，供比较专用，
// 写回后二次处理时字符串会被当对象解构而变形。
if (process.argv[2] === "--normalize") {
  writeFileSync(
    FILE,
    JSON.stringify(normalizedObject(readFileSync(FILE, "utf8")), null, 2) + "\n",
  );
  console.log("stryker-incremental.json 已规范化写回");
  process.exit(0);
}

const head = execSync(`git show HEAD:${FILE}`, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (current !== canonical(head)) {
  console.error(
    "::error::stryker-incremental.json 与提交基线不一致（内容级差异）。" +
      "请本地运行 pnpm mutation 后将更新后的基线一并提交。",
  );
  process.exit(1);
}
console.log("stryker-incremental.json 基线一致（键序/mutant 序无关比较通过）");
