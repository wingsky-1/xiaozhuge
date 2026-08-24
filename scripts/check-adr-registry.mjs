#!/usr/bin/env node
/**
 * 校验 docs/adr/ 注册表一致性：
 * 1. 文件名 = NNNN-kebab-case-topic.md（四位零填充编号）；
 * 2. 编号全局唯一——允许空洞（并行分支各占一号、合并序不定，禁空洞会卡死合法并行工作）；
 * 3. 首行标题 `# ADR <编号>: <标题>` 且编号与文件名一致，防止改名后正文引用失配。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "docs/adr";
const FILE_RE = /^(\d{4})-[a-z0-9-]+\.md$/;
const TITLE_RE = /^# ADR (\d{4}): /;

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
    errors.push(`ADR 编号 ${num} 重复: ${byNumber.get(num)} 与 ${file}`);
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

if (errors.length > 0) {
  for (const message of errors) console.error(`::error::${message}`);
  console.error(`::error::ADR 注册表校验失败（${errors.length} 处）`);
  process.exit(1);
}
console.log(
  `ADR registry OK: ${byNumber.size} entries (${[...byNumber.keys()].sort().join(", ")})`,
);
