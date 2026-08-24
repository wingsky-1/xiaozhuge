#!/usr/bin/env node
/**
 * 校验 stryker-incremental.json 与提交基线是否内容一致。
 * 两层规范化后比较：
 * 1. 对象键递归排序（Stryker 键序不稳定）；
 * 2. 每个文件的 mutants 列表按多重集合语义比较——剥离 id / killedBy /
 *    testsCompleted（跨运行非确定），其余字段构成签名后排序。
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

/** 单个 mutant 的运行无关签名：剥掉跨运行非确定的字段。 */
function mutantSignature(mutant) {
  const { id, killedBy, testsCompleted, coveredBy, statusReason, ...rest } = mutant;
  void id; void killedBy; void testsCompleted; void coveredBy; void statusReason;
  return JSON.stringify(sortDeep(rest));
}

function canonical(text) {
  const parsed = JSON.parse(text);
  // projectRoot 是生成环境相关的绝对路径（本地/CI 各不同），不参与一致性比较
  delete parsed.projectRoot;
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
