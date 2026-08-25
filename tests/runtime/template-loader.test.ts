/**
 * oss-maintenance 模板验收：真实模板文件经 loadTemplate 加载并全绿通过
 * P2b 校验器（issue #10 验收「Role Spec 校验全绿」）；负例确认加载器
 * 对损坏模板的拒绝语义与来源标记注入。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinScenarioDir,
  instantiateSnapshot,
  loadTemplate,
  listScenarios,
  resolveScenarioDir,
  resolveBuiltinScenarioDir,
  listBuiltinScenarios,
} from "../../src/index.js";
import { fileURLToPath } from "node:url";
import type { ScenarioRoot } from "../../src/index.js";

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

describe("三级来源解析（ADR 0013）", () => {
  /** 构造一个可用的场景目录（team.yaml + roles + prompts 最小合法集）。 */
  function makeScenario(root: string, name: string): void {
    const dir = join(root, name);
    mkdirSync(join(dir, "roles"), { recursive: true });
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts", "master.md"), `# ${name} master\n`);
    writeFileSync(join(dir, "prompts", "worker.md"), `# ${name} worker\n`);
    writeFileSync(
      join(dir, "team.yaml"),
      JSON.stringify({
        name,
        version: 1,
        tiers: [
          { id: "master", prompt: "./prompts/master.md" },
          { id: "worker", prompt: "./prompts/worker.md" },
        ],
        roles: ["master", "worker", "qa"],
      }),
    );
    writeFileSync(
      join(dir, "roles", "master.role.yaml"),
      JSON.stringify({ id: "master", prompt: "./prompts/master.md", dod: ["d"] }),
    );
    writeFileSync(
      join(dir, "roles", "worker.role.yaml"),
      JSON.stringify({ id: "worker", prompt: "./prompts/worker.md", dod: ["d"] }),
    );
    writeFileSync(
      join(dir, "roles", "qa.role.yaml"),
      JSON.stringify({ id: "qa", prompt: "./prompts/worker.md", as_judge: true, dod: ["d"] }),
    );
  }

  let userRoot: string;
  let projRoot: string;
  let roots: ScenarioRoot[];
  beforeEach(() => {
    userRoot = join(scratch, "user");
    projRoot = join(scratch, "project");
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(projRoot, { recursive: true });
    roots = [
      { source: "builtin", dir: join(REPO_ROOT, "templates") },
      { source: "user", dir: userRoot },
      { source: "project", dir: projRoot },
    ];
  });

  it("枚举：三级实时扫描、同名多行并存、builtin→user→project 固定序", () => {
    makeScenario(userRoot, "alpha");
    makeScenario(userRoot, "oss-maintenance"); // 与 builtin 同名
    makeScenario(projRoot, "oss-maintenance"); // 三级同名
    makeScenario(projRoot, "zeta");
    // 非目录/无 team.yaml 不入列
    mkdirSync(join(userRoot, "bad-dir"), { recursive: true });
    writeFileSync(join(userRoot, "file.txt"), "x");

    const entries = listScenarios(roots);
    const oss = entries.filter((e) => e.name === "oss-maintenance").map((e) => e.source);
    expect(oss).toEqual(["builtin", "user", "project"]);
    const names = entries.map((e) => `${e.source}:${e.name}`);
    // 固定序：builtin 层两场景前、user 层次之、project 层最后；同源内字典序
    expect(names).toEqual([
      "builtin:oss-maintenance",
      "builtin:research-report",
      "user:alpha",
      "user:oss-maintenance",
      "project:oss-maintenance",
      "project:zeta",
    ]);
  });

  it("唯一场景：resolveScenarioDir 直接命中，标记正确来源", () => {
    makeScenario(userRoot, "alpha");
    const { dir, source } = resolveScenarioDir(roots, "alpha");
    expect(source).toBe("user");
    expect(dir).toBe(join(userRoot, "alpha"));
  });

  it("同名未指定 source → ambiguous-scenario（绝不静默择一）", () => {
    makeScenario(userRoot, "dup");
    makeScenario(projRoot, "dup");
    expect(() => resolveScenarioDir(roots, "dup")).toThrow(/ambiguous-scenario: "dup"/);
  });

  it("指定 source 消歧：命中该层；该层缺失 → unknown-scenario", () => {
    makeScenario(userRoot, "dup");
    makeScenario(projRoot, "dup");
    const userHit = resolveScenarioDir(roots, "dup", "user");
    expect(userHit.source).toBe("user");
    const projHit = resolveScenarioDir(roots, "dup", "project");
    expect(projHit.source).toBe("project");
    expect(() => resolveScenarioDir(roots, "dup", "builtin")).toThrow(/unknown-scenario/);
  });

  it("场景名白名单三级统一执行：非法名即拒（含穿越形态）", () => {
    makeScenario(userRoot, "ok");
    for (const bad of ["../escape", "a/b", "OSS", "a b", "a;b"]) {
      expect(() => resolveScenarioDir(roots, bad), bad).toThrow(/unknown-scenario/);
    }
  });

  it("不存在的场景 → unknown-scenario", () => {
    expect(() => resolveScenarioDir(roots, "ghost")).toThrow(/unknown-scenario/);
  });

  it("prompt 相对路径穿越场景目录即拒（realpath 收敛）", async () => {
    const dir = join(userRoot, "escape");
    mkdirSync(join(dir, "roles"), { recursive: true });
    // team.yaml 引用 ../secret.md（越界）；secret.md 存在于 userRoot 下
    writeFileSync(join(userRoot, "secret.md"), "TOP SECRET");
    writeFileSync(
      join(dir, "team.yaml"),
      JSON.stringify({
        name: "escape",
        version: 1,
        tiers: [{ id: "master", prompt: "../secret.md" }],
        roles: ["master", "qa"],
      }),
    );
    writeFileSync(
      join(dir, "roles", "master.role.yaml"),
      JSON.stringify({ id: "master", prompt: "../secret.md", dod: ["d"] }),
    );
    writeFileSync(
      join(dir, "roles", "qa.role.yaml"),
      JSON.stringify({ id: "qa", prompt: "../secret.md", as_judge: true, dod: ["d"] }),
    );
    await expect(loadTemplate(dir, "user")).rejects.toThrow(/reference.*escape|prompt path escapes/);
  });

  it("prompt symlink 逃逸场景目录即拒", async () => {
    const dir = join(userRoot, "symlink-escape");
    mkdirSync(join(dir, "roles"), { recursive: true });
    mkdirSync(join(dir, "prompts"), { recursive: true });
    // 外部机密文件
    writeFileSync(join(userRoot, "external-secret.md"), "SECRET");
    // prompts/master.md 是指向外部文件的 symlink
    symlinkSync(join(userRoot, "external-secret.md"), join(dir, "prompts", "master.md"));
    writeFileSync(
      join(dir, "team.yaml"),
      JSON.stringify({
        name: "symlink-escape",
        version: 1,
        tiers: [{ id: "master", prompt: "./prompts/master.md" }],
        roles: ["master", "qa"],
      }),
    );
    writeFileSync(
      join(dir, "roles", "master.role.yaml"),
      JSON.stringify({ id: "master", prompt: "./prompts/master.md", dod: ["d"] }),
    );
    writeFileSync(
      join(dir, "roles", "qa.role.yaml"),
      JSON.stringify({ id: "qa", prompt: "./prompts/master.md", as_judge: true, dod: ["d"] }),
    );
    await expect(loadTemplate(dir, "user")).rejects.toThrow(/prompt path escapes/);
  });

  it("场景目录本身 symlink（用户 link 模板进来）允许，prompt 收敛其内", async () => {
    // 外部真实模板目录（不含 symlink）
    const external = join(scratch, "external-tpl");
    mkdirSync(join(external, "roles"), { recursive: true });
    mkdirSync(join(external, "prompts"), { recursive: true });
    writeFileSync(join(external, "prompts", "master.md"), "# linked master\n");
    writeFileSync(join(external, "prompts", "worker.md"), "# linked worker\n");
    writeFileSync(
      join(external, "team.yaml"),
      JSON.stringify({
        name: "linked",
        version: 1,
        tiers: [
          { id: "master", prompt: "./prompts/master.md" },
          { id: "worker", prompt: "./prompts/worker.md" },
        ],
        roles: ["master", "worker", "qa"],
      }),
    );
    writeFileSync(
      join(external, "roles", "master.role.yaml"),
      JSON.stringify({ id: "master", prompt: "./prompts/master.md", dod: ["d"] }),
    );
    writeFileSync(
      join(external, "roles", "worker.role.yaml"),
      JSON.stringify({ id: "worker", prompt: "./prompts/worker.md", dod: ["d"] }),
    );
    writeFileSync(
      join(external, "roles", "qa.role.yaml"),
      JSON.stringify({ id: "qa", prompt: "./prompts/worker.md", as_judge: true, dod: ["d"] }),
    );
    // user 层只有 symlink 指向外部目录
    symlinkSync(external, join(userRoot, "linked"));

    const loaded = await loadTemplate(join(userRoot, "linked"), "user");
    expect(loaded.template.name).toBe("linked");
    expect(loaded.source).toBe("user");
  });
});

describe("向后兼容性（resolveBuiltinScenarioDir / listBuiltinScenarios）", () => {
  it("resolveBuiltinScenarioDir 仍可解析 builtin 场景", () => {
    const dir = resolveBuiltinScenarioDir(REPO_ROOT, "oss-maintenance");
    expect(dir).toBe(join(REPO_ROOT, "templates", "oss-maintenance"));
  });

  it("listBuiltinScenarios 仍可枚举 builtin 场景名", () => {
    const names = listBuiltinScenarios(REPO_ROOT);
    expect(names).toContain("oss-maintenance");
    expect(names).toContain("research-report");
  });
});
