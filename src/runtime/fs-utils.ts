/**
 * 原子文件原语：同目录唯一临时文件 + rename（POSIX 同目录 rename 原子）。
 * 故障模型为进程崩溃（page cache 不丢）；掉电级持久性（父目录 fsync）属
 * 过度设计，不在此实现。
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 临时文件前缀；目录枚举时须过滤，recovery 负责清扫。 */
export const TMP_PREFIX = ".tmp-";

/** 确保目录存在（递归）。 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename 到位。
 * 崩溃只可能残留临时文件（不影响读者），由 {@link sweepTmp} 清扫。
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const dir = dirname(file);
  await ensureDir(dir);
  const tmp = join(dir, `${TMP_PREFIX}${basename(file)}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, file);
}

/** 读 JSON 文件；不存在时返回 undefined。 */
export async function readJson<T>(file: string): Promise<T | undefined> {
  if (!existsSync(file)) return undefined;
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/**
 * 清扫目录内的原子写临时残片（一级）。
 * @returns 清除的文件数。
 */
export async function sweepTmp(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let swept = 0;
  for (const entry of await readdir(dir)) {
    if (!entry.startsWith(TMP_PREFIX)) continue;
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
