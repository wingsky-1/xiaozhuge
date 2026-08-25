/**
 * Tier-0 规程分层与组装守门（issue #42，增量 ADR 0009）。
 *
 * 三道闸：
 * 1. 分隔符格式锁定——分隔符是显式协议常量，改动即协议变更；
 * 2. 正向组装——init 返回值（HTTP 面经 /api/xiaozhuge/team/create，工具面已下线）
 *    = 规程全文 + 分隔符 + 场景 tiers[0].prompt，
 *   对任意场景成立（含单层 research-report，#39 依赖方）；
 * 3. 反向守门——内置模板场景 prompt 不得复制规程特征句，防双副本漂移复发。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  assembleTier0Prompt,
  instantiateSnapshot,
  loadTemplate,
  loadTier0Playbook,
  PLAYBOOKS_DIR,
  TIER0_PLAYBOOK_FILE,
  TIER0_PLAYBOOK_SEPARATOR,
} from "../../src/index.js";
import { createHandlers, type Handlers } from "../../src/plugin/handlers.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const OSS_DIR = join(REPO_ROOT, "templates", "oss-maintenance");
const RR_DIR = join(REPO_ROOT, "templates", "research-report");
const PLAYBOOK_PATH = join(REPO_ROOT, PLAYBOOKS_DIR, TIER0_PLAYBOOK_FILE);

/** 规程正文独有的特征句（框架协议知识，场景层不得复制）。 */
const PLAYBOOK_SIGNATURES = [
  "资源防护三项",
  "启动对账节",
  "状态级重建",
  "blocked_streak",
  "循环不变量",
  "连续三圈零事件",
];

describe("分隔符协议常量", () => {
  // 格式锁定：本断言变化 = 协议变更，须走增量 ADR。
  it("分隔符确切格式被锁定", () => {
    expect(TIER0_PLAYBOOK_SEPARATOR).toBe(
      "\n\n===== tier0 playbook / scenario prompt boundary =====\n\n",
    );
  });
});

describe("规程加载（playbooks/ 唯一事实源）", () => {
  it("全文读入且 digest 为源文件 sha256 前 16 位", () => {
    const playbook = loadTier0Playbook(REPO_ROOT);
    const raw = readFileSync(PLAYBOOK_PATH, "utf8");
    expect(playbook.text).toBe(raw);
    expect(playbook.digest).toBe(createHash("sha256").update(raw).digest("hex").slice(0, 16));
    expect(playbook.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("规程文件随包存在于 playbooks/ 落点", () => {
    expect(existsSync(PLAYBOOK_PATH)).toBe(true);
    expect(existsSync(join(REPO_ROOT, "docs", "patrol", "tier0-playbook.md"))).toBe(false);
  });
});

describe("正向组装：tier0_prompt = 规程全文 + 分隔符 + 场景段", () => {
  let home: string;
  let handlers: Handlers;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "xzg-pb-"));
    handlers = createHandlers(home, "session-playbook-1");
  });

  it("init 组装结果逐字节等于公式，快照记录 playbook_digest", async () => {
    const result = (await handlers.init({})) as {
      tier0_prompt: string;
      playbook_digest: string;
    };
    const playbook = loadTier0Playbook(REPO_ROOT);
    const scenarioPrompt = readFileSync(join(OSS_DIR, "prompts", "master.md"), "utf8");
    expect(result.tier0_prompt).toBe(assembleTier0Prompt(playbook, scenarioPrompt));
    // 规程全文完整在场（#11 缺口不回潮）
    expect(result.tier0_prompt).toContain(playbook.text);
    expect(result.playbook_digest).toBe(playbook.digest);
    // 快照审计字段
    const snapshot = JSON.parse(await readFile(join(home, "team.yaml"), "utf8")) as {
      playbook_digest?: string;
    };
    expect(snapshot.playbook_digest).toBe(playbook.digest);
  });

  it("research-report（单层场景）经同一组装公式同样获得规程全文（#39 依赖）", async () => {
    const loaded = await loadTemplate(RR_DIR, "builtin");
    const playbook = loadTier0Playbook(REPO_ROOT);
    const scenarioPrompt = loaded.prompts["./prompts/master.md"] ?? "";
    const assembled = assembleTier0Prompt(playbook, scenarioPrompt);
    expect(scenarioPrompt.length).toBeGreaterThan(0);
    expect(assembled).toContain(playbook.text);
    expect(assembled.indexOf(playbook.text)).toBeLessThan(assembled.indexOf(TIER0_PLAYBOOK_SEPARATOR));
  });

  it("旧口径兼容：instantiateSnapshot 不传 digest 时快照字段为 null", async () => {
    const loaded = await loadTemplate(OSS_DIR, "builtin");
    const snapshot = instantiateSnapshot(loaded) as { playbook_digest: unknown };
    expect(snapshot.playbook_digest).toBeNull();
  });
});

describe("反向守门：内置模板场景 prompt 不得复制规程特征句", () => {
  it("templates/*/prompts/*.md 全量扫描零命中", () => {
    const templatesDir = join(REPO_ROOT, "templates");
    for (const scenario of readdirSync(templatesDir)) {
      const promptsDir = join(templatesDir, scenario, "prompts");
      if (!existsSync(promptsDir)) continue;
      for (const file of readdirSync(promptsDir)) {
        const content = readFileSync(join(promptsDir, file), "utf8");
        for (const sig of PLAYBOOK_SIGNATURES) {
          expect(content.includes(sig), `${scenario}/prompts/${file} 含规程特征句「${sig}」`).toBe(false);
        }
      }
    }
  });

  it("特征句清单本身仍全部命中现行规程（防守门空转）", () => {
    const playbookText = readFileSync(PLAYBOOK_PATH, "utf8");
    for (const sig of PLAYBOOK_SIGNATURES) {
      expect(playbookText.includes(sig), `特征句「${sig}」已不在规程中，须更新清单`).toBe(true);
    }
  });
});
