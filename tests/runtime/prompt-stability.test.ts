/**
 * 提示词组装稳定性回归锁口（#86 排期序 5）。
 *
 * 背景：LLM 前缀缓存命中取决于请求前缀的字节级稳定。框架可控面为三处
 * 确定性组装：tier0_prompt 组装、模板实例化快照、工具清单保留段。
 * 本文件锁定「同输入必产同字节」——任何引入前缀漂移的实现改动在此变红；
 * 易变内容（instantiated_at 时间戳）显式豁免并单列断言。
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleTier0Prompt,
  builtinTemplatesRoot,
  instantiateSnapshot,
  loadTemplate,
  loadTier0Playbook,
  PLAYBOOKS_DIR,
  TIER0_PLAYBOOK_FILE,
  TIER0_PLAYBOOK_SEPARATOR,
} from "../../src/index.js";
import { appendToolManifest, TOOL_MANIFEST_SEPARATOR } from "../../src/plugin/tool-manifest.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const RR_DIR = join(builtinTemplatesRoot(REPO_ROOT), "research-report");

/** 剥离时间戳字段后的快照序列化（唯一合法易变源）。 */
function stableSnapshotJson(snapshot: Record<string, unknown>): string {
  const { instantiated_at: _ignored, ...rest } = snapshot;
  return JSON.stringify(rest);
}

describe("tier0_prompt 组装稳定性", () => {
  it("同输入两次调用字节级一致，且静态规程整体前置", async () => {
    const playbook = loadTier0Playbook(REPO_ROOT);
    const loaded = await loadTemplate(RR_DIR, "builtin");
    const scenarioPrompt = loaded.prompts["./prompts/master.md"] ?? "";

    const first = assembleTier0Prompt(playbook, scenarioPrompt);
    const second = assembleTier0Prompt(playbook, scenarioPrompt);
    expect(first).toBe(second);

    // 静态骨架前置：规程全文在分隔符之前，动态场景内容只在其后追加。
    expect(first.startsWith(playbook.text + TIER0_PLAYBOOK_SEPARATOR)).toBe(true);
  });

  it("规程 digest 与 playbook 文件内容一一对应（跨实例共享前缀的前提）", () => {
    const a = loadTier0Playbook(REPO_ROOT);
    const b = loadTier0Playbook(REPO_ROOT);
    expect(a.text).toBe(b.text);
    expect(a.digest).toBe(b.digest);
  });
});

describe("模板实例化快照稳定性", () => {
  it("两次实例化除时间戳外字节级一致（角色顺序稳定、prompt 内联保序）", async () => {
    const s1 = instantiateSnapshot(await loadTemplate(RR_DIR, "builtin"), "dig", "/tmp/ws");
    const s2 = instantiateSnapshot(await loadTemplate(RR_DIR, "builtin"), "dig", "/tmp/ws");

    // 唯一合法易变源：instantiated_at 单调。
    expect((s1.instantiated_at as number) <= (s2.instantiated_at as number)).toBe(true);
    expect(stableSnapshotJson(s1)).toBe(stableSnapshotJson(s2));

    // 角色清单顺序稳定（loader 已按目录名排序）：前缀可复现的直接来源。
    const roles1 = JSON.stringify((s1.roles as Array<{ id: string }>).map((r) => r.id));
    const roles2 = JSON.stringify((s2.roles as Array<{ id: string }>).map((r) => r.id));
    expect(roles1).toBe(roles2);
    expect(roles1.length).toBeGreaterThan(0);
  });
});

describe("工具清单保留段稳定性", () => {
  it("多次生成字节级一致，追加位置恒为尾部", () => {
    const base = "TIER0_PROMPT";
    const once = appendToolManifest(base);
    const twice = appendToolManifest(base);
    expect(once).toBe(twice);
    expect(once.startsWith(base + TOOL_MANIFEST_SEPARATOR)).toBe(true);
  });
});
