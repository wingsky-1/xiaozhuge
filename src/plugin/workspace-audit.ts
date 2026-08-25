/**
 * 工作区旁路对账（report-only，ADR 0015 决策 1 · scope=audit 子命令）。
 *
 * 机械比对「账本 touched_paths 登记集合 ↔ 工作树实际新增文件」，
 * 定位是提高违规检出率（威慑），不是杜绝违规——done 迁移卡点待
 * report-only 版跑出真实误报率数据后单独立项评审。
 *
 * 安全硬约束（ADR 0015）：只输出路径 + mtime + size，禁止读取文件内容；
 * 敏感文件名打掩码（防止 .env/密钥类未登记文件的内容线索进入 LLM 上下文）；
 * 扫描根钉死为快照持久化的工作区，不接受调用方传参（防任意目录枚举）；
 * 目录遍历带固定忽略清单与条目上限（防巨树拖垮工具调用）。
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** 单文件审计条目：只有元数据，绝无内容。 */
export interface FileAuditEntry {
  path: string;
  size: number;
  mtime: number;
  /** 敏感文件名命中：路径已掩码，仅保留目录结构与标记。 */
  sensitive_masked: boolean;
}

export interface WorkspaceAuditReport {
  available: boolean;
  reason?: string;
  scanned_root?: string;
  /** 工作树中存在、但未登记于任何任务 touched_paths 的文件。 */
  unregistered_files: FileAuditEntry[];
  /** 账本登记了、但工作树中不存在的路径（过期登记）。 */
  stale_registered_paths: string[];
  truncated: boolean;
}

/** 固定忽略目录（构建产物 / 依赖 / 版本控制 / 框架运行时）。 */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "reports",
  ".stryker-tmp",
  ".dsh",
  ".xiaozhuge",
]);

/** 敏感文件名模式（命中即掩码，绝不展开内容或完整路径）。 */
const SENSITIVE_NAME_PATTERNS = [
  /^\.env/i,
  /\.pem$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /(^|[._-])credential/i,
  /(^|[._-])secret/i,
  /(^|[._-])token/i,
  /(^|[._-])password/i,
];

/** 条目上限：超过即截断并置 truncated（防巨树）。 */
const MAX_ENTRIES = 5000;
/** 单目录扇出上限：防御符号链接循环之外的异常深树。 */
const MAX_DEPTH = 24;

function isSensitiveName(name: string): boolean {
  return SENSITIVE_NAME_PATTERNS.some((re) => re.test(name));
}

function maskSensitive(entry: FileAuditEntry): FileAuditEntry {
  const parts = entry.path.split(sep);
  parts[parts.length - 1] = "<masked:sensitive-name>";
  return { ...entry, path: parts.join(sep), sensitive_masked: true };
}

function walk(root: string, rel: string, depth: number, out: FileAuditEntry[], state: { truncated: boolean }): void {
  if (state.truncated || out.length >= MAX_ENTRIES || depth > MAX_DEPTH) {
    if (out.length >= MAX_ENTRIES) state.truncated = true;
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(join(root, rel));
  } catch {
    return; // 无权限/已消失：跳过，不中断对账
  }
  for (const name of entries) {
    if (out.length >= MAX_ENTRIES) {
      state.truncated = true;
      return;
    }
    const relChild = rel ? `${rel}${sep}${name}` : name;
    const abs = join(root, relChild);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!IGNORED_DIRS.has(name)) walk(root, relChild, depth + 1, out, state);
    } else if (st.isFile()) {
      const entry: FileAuditEntry = {
        path: relChild,
        size: st.size,
        mtime: st.mtimeMs,
        sensitive_masked: false,
      };
      out.push(isSensitiveName(name) ? maskSensitive(entry) : entry);
    }
  }
}

/**
 * 对账报告：工作树全量文件（元数据）与账本登记集合的双向 diff。
 * @param workspace 审计根（必须来自快照持久化字段；null 即审计不可用）。
 * @param registeredPaths 账本全部任务的 touched_paths 并集。
 */
export function auditWorkspace(workspace: string | null, registeredPaths: string[]): WorkspaceAuditReport {
  if (!workspace || !existsSync(workspace)) {
    return {
      available: false,
      reason: "workspace not recorded in instance snapshot or missing on disk; audit unavailable",
      unregistered_files: [],
      stale_registered_paths: [],
      truncated: false,
    };
  }
  const files: FileAuditEntry[] = [];
  const state = { truncated: false };
  walk(workspace, "", 0, files, state);

  // 登记 paths 统一归一化为「相对审计根」形态再比对（兼容绝对/相对登记）。
  const normalizedRegistered = new Set<string>();
  for (const p of registeredPaths) {
    const rel = p.startsWith(workspace) ? relative(workspace, p) : p;
    normalizedRegistered.add(rel.split("/").join(sep));
  }

  const unregistered_files = files.filter((f) => !normalizedRegistered.has(f.path));
  const stale_registered_paths = [...normalizedRegistered].filter(
    (p) => !existsSync(join(workspace, p)),
  );

  return {
    available: true,
    scanned_root: workspace,
    unregistered_files,
    stale_registered_paths,
    truncated: state.truncated,
  };
}
