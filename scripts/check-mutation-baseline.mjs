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
import { readFileSync } from "node:fs";

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
 * 单个 mutant 的运行无关身份签名：
 * - 剥离跨运行非确定字段（id/killedBy/testsCompleted/coveredBy/statusReason）；
 * - 剥离 status/statusReason——增量模式结果会翻转，score 由 Stryker 门禁保障；
 * - location 只保留 start（end 是运行期列宽，增量产物会漂移）；
 * - 保留 mutatorName / replacement / static / location.start 作为稳定身份。
 */
function mutantSignature(mutant) {
  const { id, killedBy, testsCompleted, coveredBy, statusReason, status, location, ...rest } = mutant;
  void id; void killedBy; void testsCompleted; void coveredBy; void statusReason; void status;
  const stableLocation = location ? { start: location.start } : undefined;
  return JSON.stringify(sortDeep({ ...rest, location: stableLocation }));
}

function canonical(text) {
  const parsed = JSON.parse(text);
  // projectRoot 是生成环境相关的绝对路径（本地/CI 各不同），不参与一致性比较
  delete parsed.projectRoot;
  // tests 段是「测试索引 -> 名称」的运行期映射，id 编号随执行顺序漂移，
  // 不参与一致性比较；mutant 的 coveredBy/killedBy 已在签名中剥离。
  if (parsed.tests !== undefined) parsed.tests = [];
  if (parsed.testFiles !== undefined) parsed.testFiles = [];
  const normalized = sortDeep(parsed);
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

const current = canonical(readFileSync(FILE, "utf8"));
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
