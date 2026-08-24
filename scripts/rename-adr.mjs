#!/usr/bin/env node
/**
 * ADR 改名并同步全仓引用（并行撞号后的标准修复动作）：
 *
 *   node scripts/rename-adr.mjs <旧编号> <新编号>
 *
 * 动作：
 * 1. git mv 对应文件到新编号的文件名；
 * 2. 更新正文首行标题中的编号；
 * 3. 在 docs/ src/ tests/ scripts/ 中把 `ADR <旧编号>` 引用替换为 `ADR <新编号>`。
 * 完成后自行 review 并提交；CI 的 check-adr-registry 会做最终校验。
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "docs/adr";
const SCAN_ROOTS = ["docs", "src", "tests", "scripts"];
const SCAN_SKIP = new Set(["node_modules", "dist", ".git", ".dsh", ".stryker-tmp"]);
const SCAN_EXTS = new Set([".md", ".mjs", ".js", ".ts", ".yml", ".yaml"]);

const [oldNum, newNum] = process.argv.slice(2);
const NUM_RE = /^\d{4}$/;
if (!NUM_RE.test(oldNum ?? "") || !NUM_RE.test(newNum ?? "")) {
  console.error("用法: node scripts/rename-adr.mjs <旧编号4位> <新编号4位>");
  process.exit(1);
}
if (oldNum === newNum) {
  console.error("新旧编号相同，无需改名");
  process.exit(1);
}

const files = readdirSync(DIR).filter((f) => f.startsWith(`${oldNum}-`) && f.endsWith(".md"));
if (files.length === 0) {
  console.error(`未找到编号 ${oldNum} 对应的 ADR 文件`);
  process.exit(1);
}
if (files.length > 1) {
  console.error(`编号 ${oldNum} 存在多个文件（本就处于撞号状态），请先人工处理: ${files.join(", ")}`);
  process.exit(1);
}
const oldFile = files[0];

// 新编号必须未被占用
const occupied = readdirSync(DIR).some((f) => f.startsWith(`${newNum}-`) && f.endsWith(".md"));
if (occupied) {
  console.error(`目标编号 ${newNum} 已被占用`);
  process.exit(1);
}

const newFile = `${newNum}${oldFile.slice(4)}`;
execSync(`git mv ${JSON.stringify(join(DIR, oldFile))} ${JSON.stringify(join(DIR, newFile))}`, {
  stdio: "inherit",
});

// 正文头标题编号同步
const titlePath = join(DIR, newFile);
const titleText = readFileSync(titlePath, "utf8");
writeFileSync(
  titlePath,
  titleText.replace(/^# ADR \d{4}:/, `# ADR ${newNum}:`),
);

// 全仓引用替换
let refCount = 0;
for (const root of SCAN_ROOTS) {
  walk(root, (path) => {
    const text = readFileSync(path, "utf8");
    const updated = text.replace(/\bADR[ -](\d{4})\b/g, (whole, num) =>
      num === oldNum ? `ADR ${newNum}` : whole,
    );
    if (updated !== text) {
      writeFileSync(path, updated);
      refCount += 1;
      console.log(`updated refs: ${path}`);
    }
  });
}

console.log(`OK: ${join(DIR, oldFile)} -> ${join(DIR, newFile)}，引用更新 ${refCount} 个文件`);
console.log("请 review 改动后自行提交");

/** 递归遍历目录，对每个可扫描扩展名的文件执行 callback。 */
function walk(dir, callback) {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of dirents) {
    if (SCAN_SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, callback);
    } else if (SCAN_EXTS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      callback(path);
    }
  }
}
