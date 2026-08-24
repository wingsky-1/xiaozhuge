#!/usr/bin/env node
/**
 * 校验 stryker-incremental.json 与提交基线是否内容一致。
 * Stryker 序列化变异结果的 JSON 键序不稳定（逐次运行可能翻转），
 * 不能直接 git diff；此处对双方做深度键排序后再比较。
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

function canonical(text) {
  const parsed = JSON.parse(text);
  // projectRoot 是生成环境相关的绝对路径（本地/CI 各不同），不参与一致性比较
  delete parsed.projectRoot;
  return JSON.stringify(sortDeep(parsed), null, 2);
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
console.log("stryker-incremental.json 基线一致（键序无关比较通过）");
