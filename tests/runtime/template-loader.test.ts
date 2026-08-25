/**
 * oss-maintenance 模板验收：真实模板文件经 loadTemplate 加载并全绿通过
 * P2b 校验器（issue #10 验收「Role Spec 校验全绿」）；负例确认加载器
 * 对损坏模板的拒绝语义与来源标记注入。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinScenarioDir, instantiateSnapshot, loadTemplate } from "../../src/index.js";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const BUILTIN_DIR = join(REPO_ROOT, "templates", "oss-maintenance");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "xzg-tpl-"));
});

describe("包内置 oss-maintenance 模板", () => {
  it("加载并通过模板 + RoleSet 双校验，来源标记为 builtin", async () => {
    const loaded = await loadTemplate(BUILTIN_DIR, "builtin");
    expect(loaded.template.name).toBe("oss-maintenance");
    expect(loaded.template.source).toBe("builtin");
    expect(Object.keys(loaded.roles).sort()).toEqual([
      "cleaner",
      "coder",
      "hardener",
      "qa",
      "spec-writer",
    ]);
    // as_judge 唯一性已由校验器保证；qa 即 judge
    expect((loaded.roles.qa as { as_judge?: boolean }).as_judge).toBe(true);
    // 被引用的 prompt 全部内联读入
    expect(Object.keys(loaded.prompts)).toContain("./prompts/master.md");
    expect(loaded.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("实例化快照：携带来源标记、digest 与内联 prompt", async () => {
    const loaded = await loadTemplate(BUILTIN_DIR, "project");
    const snapshot = instantiateSnapshot(loaded) as {
      source: string;
      digest: string;
      roles: Array<{ id: string; prompt_inlined: string | null; as_judge: boolean }>;
    };
    expect(snapshot.source).toBe("project");
    expect(snapshot.digest).toBe(loaded.digest);
    expect(snapshot.roles).toHaveLength(5);
    for (const role of snapshot.roles) {
      expect(role.prompt_inlined).toBeTruthy();
    }
  });

  it("实例化快照（#42）：传入 playbook digest 即记录，旧调用缺省为 null", async () => {
    const loaded = await loadTemplate(BUILTIN_DIR, "builtin");
    const without = instantiateSnapshot(loaded) as { playbook_digest: unknown };
    expect(without.playbook_digest).toBeNull();
    const withDigest = instantiateSnapshot(loaded, "0123456789abcdef") as { playbook_digest: unknown };
    expect(withDigest.playbook_digest).toBe("0123456789abcdef");
  });
});

describe("加载器拒绝语义", () => {
  function makeScratchTemplate(teamContent: string): string {
    const dir = join(scratch, "scenario");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "team.yaml"), teamContent);
    return dir;
  }

  it("缺 team.yaml 即抛错", async () => {
    await expect(loadTemplate(join(scratch, "nope"), "user")).rejects.toThrow(/missing team.yaml/);
  });

  it("非 YAML 内容（tab 缩进等硬禁区）即抛错并说明解析边界", async () => {
    // 合法 JSON ≠ 全部合法 YAML：tab 缩进的键值对是 YAML 硬禁区
    const dir = makeScratchTemplate('name: "x"\n\tversion: 1\n');
    await expect(loadTemplate(dir, "user")).rejects.toThrow(/not valid YAML/);
  });

  it("顶层非映射（纯标量/数组）即拒", async () => {
    const dir = makeScratchTemplate("- just\n- a\n- list\n");
    await expect(loadTemplate(dir, "user")).rejects.toThrow(/not valid YAML/);
  });

  it("校验不通过的模板列出全部错误", async () => {
    const dir = makeScratchTemplate(
      JSON.stringify({ name: "", version: 0, tiers: [], roles: [] }),
    );
    await expect(loadTemplate(dir, "user")).rejects.toThrow(/template validation failed/);
  });

  it("引用的 prompt 文件缺失即拒", async () => {
    // 先让校验全绿（含唯一 judge 与角色定义），仅 prompt 文件缺失。
    const dir = join(scratch, "missing-prompt");
    mkdirSync(join(dir, "roles"), { recursive: true });
    writeFileSync(
      join(dir, "team.yaml"),
      JSON.stringify({
        name: "t",
        version: 1,
        tiers: [
          { id: "master", prompt: "./m.md" },
          { id: "worker", prompt: "./w-missing.md" },
        ],
        roles: ["master", "worker", "qa"],
      }),
    );
    writeFileSync(join(dir, "m.md"), "# m\n");
    writeFileSync(
      join(dir, "roles", "master.role.yaml"),
      JSON.stringify({ id: "master", prompt: "./m.md", dod: ["d"] }),
    );
    writeFileSync(
      join(dir, "roles", "worker.role.yaml"),
      JSON.stringify({ id: "worker", prompt: "./w-missing.md", dod: ["d"] }),
    );
    writeFileSync(
      join(dir, "roles", "qa.role.yaml"),
      JSON.stringify({ id: "qa", prompt: "./q.md", as_judge: true, dod: ["d"] }),
    );
    await expect(loadTemplate(dir, "user")).rejects.toThrow(/referenced prompt missing/);
  });

  it("角色集校验失败（无 judge）在加载期暴露", async () => {
    const dir = join(scratch, "nojudge");
    mkdirSync(join(dir, "roles"), { recursive: true });
    writeFileSync(
      join(dir, "team.yaml"),
      JSON.stringify({
        name: "bad",
        version: 1,
        tiers: [
          { id: "master", prompt: "./m.md" },
          { id: "worker", prompt: "./w.md" },
        ],
        roles: ["master", "worker"],
      }),
    );
    writeFileSync(join(dir, "m.md"), "# master\n");
    writeFileSync(join(dir, "w.md"), "# worker\n");
    writeFileSync(
      join(dir, "roles", "master.role.yaml"),
      JSON.stringify({ id: "master", prompt: "./m.md", dod: ["d"] }),
    );
    writeFileSync(
      join(dir, "roles", "worker.role.yaml"),
      JSON.stringify({ id: "worker", prompt: "./w.md", dod: ["d"] }),
    );
    await expect(loadTemplate(dir, "user")).rejects.toThrow(/judge-count|validation failed/);
  });

  it("内置场景目录解析指向 templates/oss-maintenance", () => {
    expect(builtinScenarioDir("/pkg/root")).toBe("/pkg/root/templates/oss-maintenance");
  });
});

describe("包内置 research-report 模板（单层，ADR 0008）", () => {
  const RR_DIR = join(REPO_ROOT, "templates", "research-report");

  it("单层 master + 五角色加载双校验全绿", async () => {
    const loaded = await loadTemplate(RR_DIR, "builtin");
    expect(loaded.template.name).toBe("research-report");
    expect(loaded.template.source).toBe("builtin");
    // 单层：tiers 恰为 [master]（下限放宽后的正例边界）
    expect(loaded.template.tiers).toHaveLength(1);
    expect(Object.keys(loaded.roles).sort()).toEqual([
      "organizer",
      "researcher",
      "reviewer",
      "verifier",
      "writer",
    ]);
    // reviewer 是唯一 judge
    expect((loaded.roles.reviewer as { as_judge?: boolean }).as_judge).toBe(true);
    // master + 五角色 prompt 全部内联读入
    expect(Object.keys(loaded.prompts)).toHaveLength(6);
    expect(Object.keys(loaded.prompts)).toContain("./prompts/master.md");
    expect(loaded.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("实例化快照：五个角色 prompt 全部内联且携带 digest", async () => {
    const loaded = await loadTemplate(RR_DIR, "builtin");
    const snapshot = instantiateSnapshot(loaded) as {
      source: string;
      digest: string;
      roles: Array<{ id: string; prompt_inlined: string | null }>;
    };
    expect(snapshot.source).toBe("builtin");
    expect(snapshot.digest).toBe(loaded.digest);
    expect(snapshot.roles).toHaveLength(5);
    for (const role of snapshot.roles) {
      expect(role.prompt_inlined).toBeTruthy();
    }
  });
});
