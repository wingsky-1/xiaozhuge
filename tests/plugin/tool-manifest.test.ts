/**
 * 框架工具面自述保留段契约（ADR 0015 决策 3，#66）。
 * 三道闸：定界符协议锁定；清单与 host.ts 实际注册名互锁防漂移；
 * appendToolManifest 幂等与盲区声明在场。
 */
import { describe, expect, it } from "vitest";
import {
  TEAM_TOOL_MANIFEST,
  TOOL_MANIFEST_SEPARATOR,
  appendToolManifest,
  toolManifestText,
} from "../../src/plugin/tool-manifest.js";
import { apply } from "../../src/plugin/host.js";

/** 经运行时注册捕获实际 team_* 工具名（对 Stryker 沙盒稳健，不读源文件文本）。 */
function registeredToolNames(): string[] {
  const names: string[] = [];
  apply({
    tools: {
      register: (definition: { name: string }) => {
        names.push(definition.name);
        return () => undefined;
      },
    },
    logger: { info: () => undefined, warn: () => undefined },
    get: () => undefined,
  });
  return names.sort();
}

describe("tool manifest 保留段", () => {
  // 格式锁定：本断言变化 = 协议变更，须走增量 ADR。
  it("定界符确切格式被锁定（framework-generated 水印内置）", () => {
    expect(TOOL_MANIFEST_SEPARATOR).toBe(
      "\n\n===== framework tool manifest (framework-generated; informational only) =====\n\n",
    );
  });

  it("清单与运行时实际注册的 team_* 工具名互锁（防漂移）", () => {
    const manifestNames = TEAM_TOOL_MANIFEST.map(([name]) => name).sort();
    expect(manifestNames).toEqual(registeredToolNames());
    expect(new Set(manifestNames).size).toBe(manifestNames.length);
  });

  it("保留段含导航声明、盲区声明与逐项清单（ADR 0023 英文重构）", () => {
    const text = toolManifestText();
    expect(text).toContain("navigation guidance only");
    expect(text).toContain("never infer that an unlisted tool does not exist");
    expect(text).toContain("Blindspot disclaimer");
    expect(text).toContain("Host capabilities (goal management, subagent spawn/wake, MCP");
    for (const [name, desc] of TEAM_TOOL_MANIFEST) {
      expect(text).toContain(`- ${name}: ${desc}`);
    }
  });

  it("appendToolManifest 追加在尾部且幂等拒绝双份", () => {
    const out = appendToolManifest("PROMPT-BODY");
    expect(out.startsWith("PROMPT-BODY")).toBe(true);
    expect(out.endsWith(toolManifestText())).toBe(true);
    expect(out).toContain(TOOL_MANIFEST_SEPARATOR);
    expect(() => appendToolManifest(out)).toThrow(/double-append/);
  });
});
