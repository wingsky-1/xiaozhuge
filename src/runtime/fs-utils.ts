/**
 * 原子文件原语（#29 第 A 项：write-file-atomic@8.0.0）。
 *
 * 跨平台原子写交给 npm 自身生产验证的实现（Windows rename EPERM 规避、
 * chmod/chown 复制、fsync）；崩溃残片两类：本仓 `.tmp-` 前缀与库的
 * `<target>.<digest>` 形态，由 {@link sweepTmp} 统一清扫。
 * 掉电级持久性（父目录 fsync）仍属过度设计，不在此层。
 */
import { link, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { join, dirname } from "node:path";

/** 临时文件前缀；目录枚举时须过滤，recovery 负责清扫。 */
export const TMP_PREFIX = ".tmp-";

/**
 * write-file-atomic 崩溃残片判定：目标均为 *.json，残片形如
 * `<target>.<digest>`（含 ".json." 且不再以 .json 结尾）。
 * 协议内无合法文件名命中此形态（信箱暂存名以 .json 结尾，不受影响）。
 */
const LIB_TMP_RESIDUE = (entry: string): boolean => entry.includes(".json.") && !entry.endsWith(".json");

/** 确保目录存在（递归）。 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * 原子写 JSON：write-file-atomic 同目录临时文件 + rename 到位。
 * 崩溃只可能残留临时文件（不影响读者），由 {@link sweepTmp} 清扫。
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file));
  await writeFileAtomic(file, JSON.stringify(value, null, 2), "utf8");
}

/** 读 JSON 文件；不存在时返回 undefined。 */
export async function readJson<T>(file: string): Promise<T | undefined> {
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/**
 * 清扫目录内的原子写临时残片（一级）：`.tmp-` 前缀与 write-file-atomic
 * `<target>.<digest>` 形态。
 * @returns 清除的文件数。
 */
export async function sweepTmp(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let swept = 0;
  for (const entry of await readdir(dir)) {
    if (!entry.startsWith(TMP_PREFIX) && !LIB_TMP_RESIDUE(entry)) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isFile()) {
      await rm(full);
      swept += 1;
    }
  }
  return swept;
}

/**
 * 归档落点限位判定：target 必须落在 root 内（防越界写入）。
 * @returns 解析后的绝对目标路径。
 */
export function confineToRoot(root: string, target: string): string {
  const resolvedRoot = root.startsWith("/") ? root : join(process.cwd(), root);
  const resolvedTarget = target.startsWith("/") ? target : join(resolvedRoot, target);
  if (!resolvedTarget.startsWith(resolvedRoot.endsWith("/") ? resolvedRoot : resolvedRoot + "/")) {
    throw new Error(`archive target escapes TEAM_HOME: ${target}`);
  }
  return resolvedTarget;
}

/**
 * 原子 create-if-not-exists 复制引用：target 已存在时抛 EEXIST（不覆盖）。
 * Node 无 RENAME_NOREPLACE；防覆盖发布只能用 link。
 * @returns true = 本次创建；false = target 已存在（调用方决定残片处理）。
 */
export async function linkNoReplace(src: string, target: string): Promise<boolean> {
  try {
    await link(src, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
