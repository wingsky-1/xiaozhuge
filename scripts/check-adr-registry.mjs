#!/usr/bin/env node
/**
 * 校验 docs/adr/ 注册表一致性：
 * 1. 文件名 = NNNN-kebab-case-topic.md（四位零填充编号）；
 * 2. 编号全局唯一——允许空洞（并行分支各占一号、合并序不定，禁空洞会卡死合法并行工作）；
 * 3. 首行标题 `# ADR <编号>: <标题>` 且编号与文件名一致，防止改名后正文引用失配；
 * 4. 全仓 `ADR <编号>` 引用必须指向已存在编号——并行撞号改名后漏改引用在此被抓住。
 *
 * 撞号修复方式：后合并一方改为下一个可用编号，
 * 运行 `node scripts/rename-adr.mjs <旧编号> <新编号>` 可同步更新全部引用。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "docs/adr";
// 引用扫描范围：文档 + 源码 + 测试 + 脚本；排除构建产物与依赖
const SCAN_ROOTS = ["docs", "src", "tests", "scripts"];
const SCAN_SKIP = new Set(["node_modules", "dist", ".git", ".dsh", ".stryker-tmp"]);
const SCAN_EXTS = new Set([".md", ".mjs", ".js", ".ts", ".yml", ".yaml"]);
const FILE_RE = /^(\d{4})-[a-z0-9-]+\.md$/;
const TITLE_RE = /^# ADR (\d{4}): /;
const REF_RE = /\bADR[ -](\d{4})\b/g;

const errors = [];
const byNumber = new Map();

let entries;
try {
  entries = readdirSync(DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
} catch (error) {
  // 仓库尚无任何 ADR（目录未建）是合法状态，视为零条通过
  if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
    console.log(`ADR registry OK: 0 entries (${DIR} 不存在)`);
    process.exit(0);
  }
  console.error(`::error::${DIR} 目录不可读: ${/** @type {Error} */ (error).message}`);
  process.exit(1);
}

for (const file of entries) {
  const match = FILE_RE.exec(file);
  if (!match) {
    errors.push(`文件名不符合 NNNN-kebab-case-topic.md 规范: ${file}`);
    continue;
  }
  const num = match[1];
  if (byNumber.has(num)) {
    errors.push(
      `ADR 编号 ${num} 重复: ${byNumber.get(num)} 与 ${file}` +
        ` —— 后合并一方请改用下一个可用编号（当前最大 ${nextFree(byNumber)}），` +
        `运行 node scripts/rename-adr.mjs ${num} <新编号> 同步更新全部引用`,
    );
  } else {
    byNumber.set(num, file);
  }
  const firstLine = readFileSync(join(DIR, file), "utf8").split("\n", 1)[0].trim();
  const titleMatch = TITLE_RE.exec(firstLine);
  if (!titleMatch) {
    errors.push(`${file}: 首行须为 "# ADR <编号>: <标题>" 格式`);
  } else if (titleMatch[1] !== num) {
    errors.push(`${file}: 正文头编号 ADR ${titleMatch[1]} 与文件名编号 ${num} 不一致`);
  }
}

/** 收集全仓 `ADR NNNN` 引用，指向不存在编号的记为错误。 */
function checkReferences() {
  for (const root of SCAN_ROOTS) {
    walk(root, (path) => {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(REF_RE)) {
        const ref = match[1];
        if (!byNumber.has(ref)) {
          // 计算相对展示路径失败时退回原始 path
          errors.push(`${path}: 引用了不存在的 ADR ${ref}`);
        }
      }
    });
  }
}

/** 递归遍历目录，对每个可扫描扩展名的文件执行 callback。 */
function walk(dir, callback) {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 扫描根不存在（如 src/ 尚未创建）不算错误
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

function nextFree(byNumber) {
  let n = 1;
  while (byNumber.has(String(n).padStart(4, "0"))) n += 1;
  return String(n).padStart(4, "0");
}

checkReferences();

if (errors.length > 0) {
  for (const message of errors) console.error(`::error::${message}`);
  console.error(`::error::ADR 注册表校验失败（${errors.length} 处）`);
  process.exit(1);
}
console.log(
  `ADR registry OK: ${byNumber.size} entries (${[...byNumber.keys()].sort().join(", ")})`,
);
