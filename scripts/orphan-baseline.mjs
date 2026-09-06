#!/usr/bin/env node
/**
 * scripts/orphan-baseline.mjs — 变异测试基线孤立分支（baseline/mutation）管理脚本
 *
 * 核心目标：
 * 将增量基线纯文本树直接提交至独立的孤立分支 refs/heads/baseline/mutation（深度恒为 1），
 * 彻底从 main 主分支代码树中剥离巨型基线 JSON 文件，消灭 Git 提交树膨胀与机器人 PR。
 *
 * 动作：
 *   node scripts/orphan-baseline.mjs push [dir]
 *     - 从指定目录（默认当前目录）收集 stryker-incremental-*.json 产物
 *     - 生成 manifest.json（文件级 size/mtime/sha256）
 *     - 用 git plumbing（hash-object -> mktree -> commit-tree）生成单 Commit 孤立纯文本树
 *     - 强制推送到 refs/heads/baseline/mutation
 *
 *   node scripts/orphan-baseline.mjs restore [dir]
 *     - 从 refs/heads/baseline/mutation 浅拉取（fetch --depth=1，带 3 次退避重试）
 *     - 将 stryker-incremental-*.json 与 manifest.json 恢复到指定目录
 *     - 失败时严格遵循 fail-closed：CI 缺失基线即 exit 1
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const action = process.argv[2];
const targetDirArg = process.argv[3] || ".";
const BRANCH = "baseline/mutation";
const TARGET_DIR = resolve(process.cwd(), targetDirArg);
const BASELINE_PATTERN = /^stryker-incremental-.+\.json$/;
const MAX_BUFFER = 64 * 1024 * 1024; // 64MB，防止巨型基线 JSON 突破 Node 默认 1MB maxBuffer

function runGit(args, options = {}) {
  const { input, env, ignoreError = false } = options;
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      input,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...env },
    }).trim();
  } catch (err) {
    if (ignoreError) return null;
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new Error(`git ${args.join(" ")} 失败：${stderr || err.message}`, { cause: err });
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getRemoteUrl() {
  const token = process.env.GITHUB_TOKEN || process.env.OBSERVE_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (token && repo) {
    return `https://x-access-token:${token}@github.com/${repo}.git`;
  }
  return "origin";
}

if (action === "push") {
  if (!existsSync(TARGET_DIR)) {
    console.error(`::error::[orphan-baseline] 源目录不存在：${TARGET_DIR}`);
    process.exit(1);
  }

  const baselineFiles = readdirSync(TARGET_DIR)
    .filter((f) => BASELINE_PATTERN.test(f))
    .sort();

  if (baselineFiles.length === 0) {
    console.error("::error::[orphan-baseline] 未找到任何 stryker-incremental-*.json 基线文件");
    process.exit(1);
  }

  // 1. 生成 manifest.json
  const manifest = {};
  for (const f of baselineFiles) {
    const fullPath = join(TARGET_DIR, f);
    const buf = readFileSync(fullPath);
    const st = statSync(fullPath);
    manifest[f] = {
      size: buf.length,
      mtime: st.mtime.toISOString(),
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  }
  const manifestPath = join(TARGET_DIR, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const allFiles = [...baselineFiles, "manifest.json"];

  console.log(`[orphan-baseline] 准备提交 ${allFiles.length} 个基线文件到孤立分支 ${BRANCH}...`);

  // 2. 用 Git plumbing 构建纯文本 Tree（享受 Git Blob 原生内容寻址与去重红利）
  const mktreeLines = [];
  for (const f of allFiles) {
    const fullPath = join(TARGET_DIR, f);
    const blobSha = runGit(["hash-object", "-w", fullPath]);
    mktreeLines.push(`100644 blob ${blobSha}\t${f}`);
  }
  const treeSha = runGit(["mktree"], { input: mktreeLines.join("\n") + "\n" });

  // 3. 构建无父节点的孤立 Commit（单 commit 纯快照，深度恒为 1）
  const commitSha = runGit(
    ["commit-tree", treeSha, "-m", "chore(baseline): update mutation baseline snapshot [skip ci]"],
    {
      env: {
        GIT_AUTHOR_NAME: "github-actions[bot]",
        GIT_AUTHOR_EMAIL: "github-actions[bot]@users.noreply.github.com",
        GIT_COMMITTER_NAME: "github-actions[bot]",
        GIT_COMMITTER_EMAIL: "github-actions[bot]@users.noreply.github.com",
      },
    },
  );

  // 4. 推送到孤立分支（硬编码分支引用，绝对禁止误写 main）
  const remoteTarget = getRemoteUrl();
  console.log(`[orphan-baseline] 强推 commit ${commitSha.slice(0, 8)} 到 refs/heads/${BRANCH}...`);
  runGit(["push", "--force", remoteTarget, `${commitSha}:refs/heads/${BRANCH}`]);
  console.log(`[orphan-baseline] 成功同步基线至孤立分支 ${BRANCH}（共 ${allFiles.length} 份文件）`);

} else if (action === "restore") {
  mkdirSync(TARGET_DIR, { recursive: true });

  // 带有退避重试的 fetch 机制（抵御网络突发抖动）
  let fetched = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = runGit(
      ["fetch", "--depth=1", "origin", `refs/heads/${BRANCH}`],
      { ignoreError: true },
    );
    if (res !== null) {
      fetched = true;
      break;
    }
    if (attempt < 3) {
      console.warn(`[orphan-baseline] Fetch 孤立分支失败，第 ${attempt}/3 次重试（等待 2s）...`);
      sleep(2000);
    }
  }

  if (!fetched) {
    const localBaselines = existsSync(TARGET_DIR)
      ? readdirSync(TARGET_DIR).filter((f) => BASELINE_PATTERN.test(f))
      : [];
    if (localBaselines.length > 0) {
      console.warn(`[orphan-baseline] 远端孤立分支 ${BRANCH} 不可达，复用本地已有的 ${localBaselines.length} 份基线文件`);
      process.exit(0);
    }
    if (process.env.CI) {
      console.error(`::error::[orphan-baseline] 无法从孤立分支 refs/heads/${BRANCH} 恢复基线且本地无基线，门禁中断 (fail-closed)`);
      process.exit(1);
    } else {
      console.warn(`[orphan-baseline] 未能拉取远端孤立分支且本地无基线。如需初始化，请本地运行 pnpm mutation 后执行 node scripts/orphan-baseline.mjs push`);
      process.exit(0);
    }
  }

  // 遍历远端 commit 中的文件并写回目标目录
  const treeOutput = runGit(["ls-tree", "-r", "FETCH_HEAD"], { ignoreError: true });
  if (!treeOutput) {
    if (process.env.CI) {
      console.error(`::error::[orphan-baseline] 孤立分支基线树为空，门禁中断 (fail-closed)`);
      process.exit(1);
    } else {
      console.warn("[orphan-baseline] 孤立分支基线树为空");
      process.exit(0);
    }
  }

  const lines = treeOutput.split("\n").filter(Boolean);
  let restored = 0;
  for (const line of lines) {
    const match = line.match(/^100644\s+blob\s+[0-9a-f]{40}\t(.+)$/);
    if (!match) continue;
    const fileName = match[1];
    if (BASELINE_PATTERN.test(fileName) || fileName === "manifest.json") {
      const content = runGit(["show", `FETCH_HEAD:${fileName}`]);
      writeFileSync(join(TARGET_DIR, fileName), content);
      restored++;
    }
  }

  if (restored > 0) {
    console.log(`[orphan-baseline] 成功恢复 ${restored} 份基线文件至 ${TARGET_DIR}`);
  } else {
    if (process.env.CI) {
      console.error(`::error::[orphan-baseline] 孤立分支中未发现基线文件，门禁中断 (fail-closed)`);
      process.exit(1);
    } else {
      console.warn("[orphan-baseline] 孤立分支中未发现基线文件");
    }
  }

} else {
  console.error(`::error::[orphan-baseline] 未知动作：${action}，用法：node scripts/orphan-baseline.mjs [push|restore] [dir]`);
  process.exit(1);
}
