/**
 * 校验器穷举负矩阵：对 validateRoleSpec / validateTeamTemplate 的每条规则
 * 逐一变异输入并断言完整错误签名（code+path+message），保证 Stryker 对
 * 条件分支与消息文本的突变全部被杀伤。
 */
import { describe, expect, it } from "vitest";
import { validateRoleSpec, validateTeamTemplate } from "../../src/index.js";

const baseSpec = { id: "coder", prompt: "./p.md" };

function codes(result: { errors: Array<{ code: string }> }): string[] {
  return result.errors.map((e) => e.code);
}

describe("validateRoleSpec 穷举负矩阵", () => {
  const cases: Array<[string, unknown, string, string, string]> = [
    // [描述, 输入, code, path, message]
    ["非对象", "nope", "role-not-object", "", "role spec must be an object"],
    ["id 缺失", { prompt: "./p.md" }, "role-id-required", "id", "role id is required"],
    ["prompt 缺失", { id: "x" }, "role-prompt-required", "prompt", "prompt reference is required"],
    [
      "briefing 非对象",
      { ...baseSpec, briefing: 3 },
      "briefing-not-object",
      "briefing",
      "briefing must be an object",
    ],
    [
      "format 非法",
      { ...baseSpec, briefing: { format: "yaml" } },
      "briefing-format-invalid",
      "briefing.format",
      "format must be structured or freeform",
    ],
    [
      "sections_required 非数组",
      { ...baseSpec, briefing: { format: "structured", sections_required: "acceptance" } },
      "sections-not-array",
      "briefing.sections_required",
      "must be an array",
    ],
    [
      "sections_required 未知小节",
      { ...baseSpec, briefing: { format: "structured", sections_required: ["poetry"] } },
      "section-unknown",
      "briefing.sections_required",
      "unknown section: poetry",
    ],
    [
      "dod 非数组",
      { ...baseSpec, dod: "build 绿" },
      "dod-not-array",
      "dod",
      "dod must be an array of strings",
    ],
    [
      "dod 与 acceptance 双缺",
      { ...baseSpec },
      "dod-or-acceptance-required",
      "dod",
      "non-empty dod or briefing.sections_required containing acceptance is required",
    ],
    [
      "dod 全空串也算缺",
      { ...baseSpec, dod: ["", ""] },
      "dod-or-acceptance-required",
      "dod",
      "non-empty dod or briefing.sections_required containing acceptance is required",
    ],
    [
      "as_judge 非布尔",
      { ...baseSpec, as_judge: "yes", dod: ["d"] },
      "as-judge-not-bool",
      "as_judge",
      "as_judge must be a boolean",
    ],
    [
      "max_hops 为零",
      { ...baseSpec, max_hops: 0 },
      "max-hops-invalid",
      "max_hops",
      "max_hops must be a positive integer",
    ],
    [
      "max_hops 为负数",
      { ...baseSpec, max_hops: -2 },
      "max-hops-invalid",
      "max_hops",
      "max_hops must be a positive integer",
    ],
    [
      "max_hops 为非整数",
      { ...baseSpec, max_hops: 1.5 },
      "max-hops-invalid",
      "max_hops",
      "max_hops must be a positive integer",
    ],
    [
      "max_hops 为字符串",
      { ...baseSpec, max_hops: "3" },
      "max-hops-invalid",
      "max_hops",
      "max_hops must be a positive integer",
    ],
  ];

  for (const [desc, input, code, path, message] of cases) {
    it(`负例：${desc}`, () => {
      const result = validateRoleSpec(input);
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual({ code, path, message });
    });
  }
});

describe("validateTeamTemplate 穷举负矩阵", () => {
  const validBase = {
    name: "n",
    version: 2,
    tiers: [
      { id: "master", prompt: "./m.md" },
      { id: "worker", prompt: "./w.md" },
    ],
    roles: [{ id: "qa", ref: "qa" }],
  };

  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "模板非对象",
      "nope",
      "template-not-object",
    ],
    ["name 空", { ...validBase, name: "" }, "name-required"],
    ["version 非整数", { ...validBase, version: 1.5 }, "version-invalid"],
    ["tiers 缺失", { ...validBase, tiers: undefined }, "tiers-required"],
    [
      "tier 缺 id",
      {
        ...validBase,
        tiers: [
          { prompt: "./a.md" },
          { id: "b", prompt: "./b.md" },
        ],
      },
      "tier-id-required",
    ],
    [
      "tier 缺 prompt",
      {
        ...validBase,
        tiers: [
          { id: "a", prompt: "" },
          { id: "b", prompt: "./b.md" },
        ],
      },
      "tier-prompt-required",
    ],
    [
      "roles 元素无引用无 id",
      { ...validBase, roles: [{ title: "x" }] },
      "role-ref-required",
    ],
    [
      "roles 引用重复",
      { ...validBase, roles: [{ ref: "qa" }, "qa"] },
      "role-duplicate",
    ],
    ["comm_mode 非法", { ...validBase, comm_mode: "hybrid" }, "comm-mode-invalid"],
    [
      "explicit 无白名单",
      { ...validBase, comm_mode: "explicit" },
      "explicit-comm-required",
    ],
    [
      "comm 边缺 to",
      { ...validBase, comm_mode: "explicit", comm: [{ from: "master", to: "" }] },
      "comm-edge-invalid",
    ],
    [
      "archives 非数组",
      { ...validBase, archives: "nope" },
      "archives-not-array",
    ],
    [
      "archive 元素缺 id",
      { ...validBase, archives: [{ type: "url", url: "https://x" }] },
      "archive-id-required",
    ],
    [
      "file 型缺 target",
      { ...validBase, archives: [{ id: "f", type: "file" }] },
      "archive-target-required",
    ],
    [
      "url 型缺 url",
      { ...validBase, archives: [{ id: "u", type: "url" }] },
      "archive-url-required",
    ],
    [
      "file target 绝对路径越界",
      { ...validBase, archives: [{ id: "f", type: "file", target: "/etc/passwd" }] },
      "archive-target-escapes",
    ],
    [
      "gates 非数组",
      { ...validBase, gates: {} },
      "gates-not-array",
    ],
    [
      "gate 缺 id",
      { ...validBase, gates: [{ at: "master" }] },
      "gate-id-required",
    ],
    [
      "gate on 格式非法",
      {
        ...validBase,
        gates: [{ id: "g1", at: "master", on: "random-text" }],
      },
      "gate-on-invalid",
    ],
    [
      "resources 非对象",
      { ...validBase, resources: [1] },
      "resources-not-object",
    ],
    [
      "stages_ext 非数组",
      { ...validBase, stages_ext: "running" },
      "stages-ext-not-array",
    ],
  ];

  for (const [desc, mutate, code] of cases) {
    it(`负例：${desc} -> ${code}`, () => {
      const tpl = typeof mutate === "object" && mutate !== null && !Array.isArray(mutate)
        ? { ...validBase, ...mutate }
        : mutate;
      const result = validateTeamTemplate(tpl);
      expect(codes(result)).toContain(code);
    });
  }

  it("gate on 合法格式放行（stage-enter 前缀约定）", () => {
    const ok = validateTeamTemplate({
      ...validBase,
      gates: [{ id: "g", at: "master", on: "stage-enter:queued" }],
    });
    expect(ok.errors.map((e) => e.code)).not.toContain("gate-on-invalid");
  });

  it("resource 计数为零也拒绝（正整数约束）", () => {
    const r = validateTeamTemplate({
      ...validBase,
      resources: { task_max_rounds: 0 },
    });
    expect(r.errors.map((e) => e.code)).toContain("resource-invalid");
  });

  it("stages_ext 含保留态即拒并给出冲突值", () => {
    const r = validateTeamTemplate({
      ...validBase,
      stages_ext: ["done"],
    });
    expect(r.errors).toContainEqual({
      code: "stage-reserved",
      path: "stages_ext",
      message: "stage conflicts with reserved: done",
    });
  });
});
