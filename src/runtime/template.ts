/**
 * Team Template 与 Role Spec 校验（v2.2 定稿 §7 / §7.1）。
 *
 * #29 第 D 项：schema 由 zod@4 声明（schema 即文档）。分层策略：
 * - 叶子/形状约束由 zod safeParse 收集（一次收集全部 issue 不短路）；
 * - 跨字段/动态规则在**原始输入**上无条件运行——实证 v4 中部分失败
 *   （枚举/数值约束）为 aborting 会跳过后续 refinement，故不依赖它。
 *
 * 错误码为稳定枚举（P3 工具层装配拒绝理由的契约）：翻译层经
 * 「消息 → 错误码」对照表回填稳定 code；无映射消息立即抛错防漂移。
 * 对外输出的 {code,path,message} 与手写版逐字段兼容（穷举负矩阵测试为裁判）。
 */
import { z } from "zod";
import { RESERVED_STAGES, TEMPLATE_SOURCES } from "./types.js";

export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

const SECTION_ENUM = ["background", "boundary", "acceptance", "forbidden"];

/** briefing.sections_required 允许的枚举。 */
export const SECTIONS_REQUIRED_ENUM = SECTION_ENUM;

interface LooseRecord {
  [key: string]: unknown;
}

/** 稳定错误码对照表：消息文本唯一，可作反向键（PR 附逐项对照报告）。 */
const CODE_BY_MESSAGE: Record<string, string> = {
  "role id is required": "role-id-required",
  "prompt reference is required": "role-prompt-required",
  "briefing must be an object": "briefing-not-object",
  "format must be structured or freeform": "briefing-format-invalid",
  "must be an array": "sections-not-array",
  "dod must be an array of strings": "dod-not-array",
  "as_judge must be a boolean": "as-judge-not-bool",
  "max_hops must be a positive integer": "max-hops-invalid",
  "template name is required": "name-required",
  "version must be a positive integer": "version-invalid",
  "tiers array is required": "tiers-required",
  "template requires 2 to 3 tiers": "tiers-length",
  "tier id is required": "tier-id-required",
  "tier prompt is required": "tier-prompt-required",
  "at least one role is required": "roles-required",
  "comm_mode must be auto or explicit": "comm-mode-invalid",
  "source must be one of builtin|user|project": "source-invalid",
  "archives must be an array": "archives-not-array",
  "gates must be an array": "gates-not-array",
  "stages_ext must be an array": "stages-ext-not-array",
};

/** 动态插值消息的前缀 → 稳定码。 */
const PREFIX_CODES: ReadonlyArray<readonly [string, string]> = [
  ["unknown section: ", "section-unknown"],
];

interface RawIssueLike {
  message?: string;
  path?: PropertyKey[];
}

/** zod issue 路径（PropertyKey[]）→ 协议点路径字符串（如 tiers[0].id）。 */
function fmtPath(path: PropertyKey[] | undefined): string {
  let out = "";
  for (const seg of path ?? []) {
    out += typeof seg === "number" ? `[${seg}]` : (out ? "." : "") + String(seg);
  }
  return out;
}

/** 翻译层：消息回填稳定码；无映射即抛错（防止错误码契约静默漂移）。 */
function translate(issues: readonly RawIssueLike[]): ValidationError[] {
  return issues.map((iss) => {
    let code = iss.message !== undefined ? CODE_BY_MESSAGE[iss.message] : undefined;
    if (code === undefined && iss.message !== undefined) {
      code = PREFIX_CODES.find(([prefix]) => iss.message!.startsWith(prefix))?.[1];
    }
    if (code === undefined) {
      throw new Error(`unmapped validation message: ${String(iss.message)}`);
    }
    return { code, path: fmtPath(iss.path), message: iss.message ?? "" };
  });
}

function str(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------- Role Spec

const roleSpecSchema = z
  .object({
    id: z
      .string({ error: "role id is required" })
      .min(1, { message: "role id is required" }),
    prompt: z
      .string({ error: "prompt reference is required" })
      .min(1, { message: "prompt reference is required" }),
    briefing: z
      .looseObject(
        {
          format: z
            .enum(["structured", "freeform"], { error: "format must be structured or freeform" })
            .optional(),
          sections_required: z.array(z.unknown(), { error: "must be an array" }).optional(),
        },
        { error: "briefing must be an object" },
      )
      .optional(),
    dod: z.array(z.unknown(), { error: "dod must be an array of strings" }).optional(),
    as_judge: z.boolean({ error: "as_judge must be a boolean" }).optional(),
    max_hops: z
      .number({ error: "max_hops must be a positive integer" })
      .int("max_hops must be a positive integer")
      .positive("max_hops must be a positive integer")
      .optional(),
  })
  .loose();

/**
 * 校验单个 Role Spec。
 * 「dod 与 acceptance 至少一处非空」：dod 非空，或 structured 简报的
 * sections_required 含 acceptance——两者满足其一即可（跨字段规则，
 * 在原始输入上无条件检查以保证与叶子层并行收集、不短路）。
 */
export function validateRoleSpec(spec: unknown): ValidationResult {
  if (typeof spec !== "object" || spec === null) {
    return { ok: false, errors: [{ code: "role-not-object", path: "", message: "role spec must be an object" }] };
  }
  const result = roleSpecSchema.safeParse(spec);
  const errors = translate(result.error?.issues ?? []);

  const s = spec as LooseRecord;
  const dodNonEmpty =
    Array.isArray(s.dod) && s.dod.some((d) => typeof d === "string" && d.length > 0);
  const sections = (s.briefing as LooseRecord | undefined)?.sections_required;
  const hasAcceptance = Array.isArray(sections) && sections.includes("acceptance");
  if (!dodNonEmpty && !hasAcceptance) {
    errors.push({
      code: "dod-or-acceptance-required",
      path: "dod",
      message: "non-empty dod or briefing.sections_required containing acceptance is required",
    });
  }
  // 未知小节逐元素报错（路径不带下标，与既有契约一致）
  if (Array.isArray(sections)) {
    for (const sec of sections) {
      if (!(SECTION_ENUM as readonly string[]).includes(sec as string)) {
        errors.push({
          code: "section-unknown",
          path: "briefing.sections_required",
          message: `unknown section: ${String(sec)}`,
        });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 校验团队角色定义集：每个 Role Spec 合法，且 as_judge=true 恰好一个。 */
export function validateRoleSet(specs: unknown[]): ValidationResult {
  let errors: ValidationError[] = [];
  let judgeCount = 0;
  specs.forEach((spec, i) => {
    const result = validateRoleSpec(spec);
    errors = errors.concat(result.errors.map((e) => ({ ...e, path: `roles[${i}].${e.path}` })));
    if (typeof spec === "object" && spec !== null && (spec as LooseRecord).as_judge === true) {
      judgeCount += 1;
    }
  });
  if (judgeCount !== 1) {
    errors.push({
      code: "judge-count",
      path: "roles",
      message: `exactly one as_judge role required, found ${judgeCount}`,
    });
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------- Team Template

const SOURCE_MSG = `source must be one of ${TEMPLATE_SOURCES.join("|")}`;

/**
 * 校验 Team Template（team.yaml 解析后的对象）。
 * roles 为「引用 + 覆盖」形态：元素是字符串引用或覆盖对象（含 id），
 * 定义集由 validateRoleSet 另行校验（定稿 §7.1：角色以独立文件定义）。
 * 跨字段规则（重复引用 / comm / archives / gates / resources / stages_ext）
 * 在原始输入上无条件检查，保证一次收集全部错误不短路。
 */
export function validateTeamTemplate(tpl: unknown): ValidationResult {
  if (typeof tpl !== "object" || tpl === null) {
    return { ok: false, errors: [{ code: "template-not-object", path: "", message: "template must be an object" }] };
  }

  const shape = z
    .object({
      name: z
        .string({ error: "template name is required" })
        .min(1, { message: "template name is required" }),
      version: z
        .number({ error: "version must be a positive integer" })
        .int("version must be a positive integer")
        .positive("version must be a positive integer"),
      tiers: z
        .array(
          z
            .object({
              id: z
                .string({ error: "tier id is required" })
                .min(1, { message: "tier id is required" }),
              prompt: z
                .string({ error: "tier prompt is required" })
                .min(1, { message: "tier prompt is required" }),
            })
            .loose(),
          { error: "tiers array is required" },
        )
        .min(2, { message: "template requires 2 to 3 tiers" })
        .max(3, { message: "template requires 2 to 3 tiers" }),
      roles: z
        .array(z.unknown(), { error: "at least one role is required" })
        .min(1, { message: "at least one role is required" }),
      comm_mode: z
        .enum(["auto", "explicit"], { error: "comm_mode must be auto or explicit" })
        .optional(),
      archives: z.array(z.unknown(), { error: "archives must be an array" }).optional(),
      gates: z.array(z.unknown(), { error: "gates must be an array" }).optional(),
      stages_ext: z.array(z.unknown(), { error: "stages_ext must be an array" }).optional(),
      source: z.enum(TEMPLATE_SOURCES as unknown as [string, ...string[]], { error: SOURCE_MSG }).optional(),
    })
    .loose();

  const result = shape.safeParse(tpl);
  const errors = translate(result.error?.issues ?? []);

  const t = tpl as LooseRecord;

  // tier id 唯一；同时收集合法 tier id 集（gates.at 引用检查用）
  const tierIds = new Set<string>();
  const tiers = t.tiers as LooseRecord[] | undefined;
  tiers?.forEach((tier, i) => {
    const id = tier?.id;
    if (str(id)) {
      if (tierIds.has(id)) {
        errors.push({
          code: "tier-duplicate",
          path: `tiers[${i}].id`,
          message: `duplicate tier id: ${id}`,
        });
      } else {
        tierIds.add(id);
      }
    }
  });

  // roles：引用与覆盖形态，引用唯一
  const seen = new Set<string>();
  const roles = t.roles as unknown[] | undefined;
  if (Array.isArray(roles) && roles.length > 0) {
    roles.forEach((role, i) => {
      const ref = typeof role === "string" ? role : (role as LooseRecord | null)?.ref;
      const overrideId =
        typeof role === "object" && role !== null ? (role as LooseRecord).id : undefined;
      const roleId = typeof ref === "string" ? ref : overrideId;
      if (!str(roleId)) {
        errors.push({
          code: "role-ref-required",
          path: `roles[${i}]`,
          message: "role must reference a defined role id",
        });
        return;
      }
      if (seen.has(roleId)) {
        errors.push({
          code: "role-duplicate",
          path: `roles[${i}]`,
          message: `duplicate role: ${roleId}`,
        });
      }
      seen.add(roleId);
    });
  }

  // comm：explicit 模式要求白名单且边完整
  if (t.comm_mode === "explicit") {
    const comm = t.comm;
    if (!Array.isArray(comm)) {
      errors.push({
        code: "explicit-comm-required",
        path: "comm",
        message: "explicit mode requires a comm whitelist array",
      });
    } else {
      comm.forEach((edge, i) => {
        const e = edge as LooseRecord | null;
        if (
          typeof edge !== "object" ||
          edge === null ||
          !str(e?.from) ||
          !str(e?.to)
        ) {
          errors.push({
            code: "comm-edge-invalid",
            path: `comm[${i}]`,
            message: "edge must have from/to",
          });
        }
      });
    }
  }

  // archives：file|url 两型硬编码；file 型 target 相对路径
  const archives = t.archives;
  if (Array.isArray(archives)) {
    archives.forEach((arc, i) => {
      const a = arc as LooseRecord | null;
      if (typeof arc !== "object" || arc === null || !str(a?.id)) {
        errors.push({
          code: "archive-id-required",
          path: `archives[${i}].id`,
          message: "archive id is required",
        });
        return;
      }
      if (a.type !== "file" && a.type !== "url") {
        errors.push({
          code: "archive-type-invalid",
          path: `archives[${i}].type`,
          message: "type must be file or url",
        });
      }
      if (a.type === "file") {
        const target = a.target;
        if (!str(target)) {
          errors.push({
            code: "archive-target-required",
            path: `archives[${i}].target`,
            message: "file archive target is required",
          });
        } else if (target.includes("..") || target.startsWith("/")) {
          errors.push({
            code: "archive-target-escapes",
            path: `archives[${i}].target`,
            message: "file target must stay inside TEAM_HOME",
          });
        }
      }
      if (a.type === "url" && !str(a.url)) {
        errors.push({
          code: "archive-url-required",
          path: `archives[${i}].url`,
          message: "url archive requires url field",
        });
      }
    });
  }

  // gates：at 引用 tier 存在；on 形如 stage-enter:<state>
  const gates = t.gates;
  if (Array.isArray(gates)) {
    gates.forEach((gate, i) => {
      const g = gate as LooseRecord | null;
      if (typeof gate !== "object" || gate === null || !str(g?.id)) {
        errors.push({
          code: "gate-id-required",
          path: `gates[${i}].id`,
          message: "gate id is required",
        });
        return;
      }
      if (!str(g.at) || !tierIds.has(g.at)) {
        errors.push({
          code: "gate-at-unknown",
          path: `gates[${i}].at`,
          message: `gate at references unknown tier: ${String(g.at)}`,
        });
      }
      if (g.on !== undefined && !/^stage-enter:[a-z][a-z0-9_-]*$/.test(String(g.on))) {
        errors.push({
          code: "gate-on-invalid",
          path: `gates[${i}].on`,
          message: "on must look like stage-enter:<state>",
        });
      }
    });
  }

  // resources：对象形态 + 正整数（跳过保留键 stages_ext）
  const resources = t.resources;
  if (resources !== undefined) {
    if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
      errors.push({
        code: "resources-not-object",
        path: "resources",
        message: "resources must be an object",
      });
    } else {
      for (const [key, val] of Object.entries(resources as LooseRecord)) {
        if (key === "stages_ext") continue;
        if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
          errors.push({
            code: "resource-invalid",
            path: `resources.${key}`,
            message: "resource limits must be positive integers",
          });
        }
      }
    }
  }

  // stages_ext：不得与保留态冲突（保留态出现即拒）
  const stagesExt = t.stages_ext;
  if (Array.isArray(stagesExt)) {
    for (const stage of stagesExt) {
      if ((RESERVED_STAGES as readonly string[]).includes(stage as string)) {
        errors.push({
          code: "stage-reserved",
          path: "stages_ext",
          message: `stage conflicts with reserved: ${String(stage)}`,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
