/**
 * Team Template 与 Role Spec 校验（v2.2 定稿 §7 / §7.1）。
 *
 * 边界：校验器接受**已解析的协议对象**（YAML→对象的解析归宿主绑定层）。
 * 一次收集全部错误不短路；错误码为稳定枚举，供 P3 工具层装配拒绝理由。
 */
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

interface LooseRecord {
  [key: string]: unknown;
}

function str(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function collect(
  errors: ValidationError[],
  code: string,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

// ---------------------------------------------------------------- Role Spec

/** briefing.sections_required 允许的枚举。 */
export const SECTIONS_REQUIRED_ENUM = SECTION_ENUM;

/**
 * 校验单个 Role Spec。
 * 「dod 与 acceptance 至少一处非空」：dod 非空，或 structured 简报的
 * sections_required 含 acceptance——两者满足其一即可。
 */
export function validateRoleSpec(spec: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (typeof spec !== "object" || spec === null) {
    return { ok: false, errors: [{ code: "role-not-object", path: "", message: "role spec must be an object" }] };
  }
  const s = spec as LooseRecord;
  if (!str(s.id)) collect(errors, "role-id-required", "id", "role id is required");
  if (!str(s.prompt)) collect(errors, "role-prompt-required", "prompt", "prompt reference is required");

  if (s.briefing !== undefined) {
    if (typeof s.briefing !== "object" || s.briefing === null) {
      collect(errors, "briefing-not-object", "briefing", "briefing must be an object");
    } else {
      const b = s.briefing as LooseRecord;
      if (b.format !== undefined && b.format !== "structured" && b.format !== "freeform") {
        collect(errors, "briefing-format-invalid", "briefing.format", "format must be structured or freeform");
      }
      if (b.sections_required !== undefined) {
        if (!Array.isArray(b.sections_required)) {
          collect(errors, "sections-not-array", "briefing.sections_required", "must be an array");
        } else {
          for (const sec of b.sections_required) {
            if (!SECTION_ENUM.includes(sec as string)) {
              collect(errors, "section-unknown", "briefing.sections_required", `unknown section: ${String(sec)}`);
            }
          }
        }
      }
    }
  }

  if (s.dod !== undefined && !Array.isArray(s.dod)) {
    collect(errors, "dod-not-array", "dod", "dod must be an array of strings");
  }
  const dodNonEmpty =
    Array.isArray(s.dod) &&
    s.dod.some((d) => typeof d === "string" && d.length > 0);
  const hasAcceptanceSection =
    Array.isArray((s.briefing as LooseRecord | undefined)?.sections_required) &&
    ((s.briefing as LooseRecord).sections_required as unknown[]).includes("acceptance");
  if (!dodNonEmpty && !hasAcceptanceSection) {
    collect(
      errors,
      "dod-or-acceptance-required",
      "dod",
      "non-empty dod or briefing.sections_required containing acceptance is required",
    );
  }

  if (s.as_judge !== undefined && typeof s.as_judge !== "boolean") {
    collect(errors, "as-judge-not-bool", "as_judge", "as_judge must be a boolean");
  }
  if (s.max_hops !== undefined) {
    if (typeof s.max_hops !== "number" || !Number.isInteger(s.max_hops) || s.max_hops <= 0) {
      collect(errors, "max-hops-invalid", "max_hops", "max_hops must be a positive integer");
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

/**
 * 校验 Team Template（team.yaml 解析后的对象）。
 * roles 为「引用 + 覆盖」形态：元素是字符串引用或覆盖对象（含 id），
 * 定义集由 validateRoleSet 另行校验（定稿 §7.1：角色以独立文件定义）。
 */
export function validateTeamTemplate(tpl: unknown): ValidationResult {
  let errors: ValidationError[] = [];
  if (typeof tpl !== "object" || tpl === null) {
    return { ok: false, errors: [{ code: "template-not-object", path: "", message: "template must be an object" }] };
  }
  const t = tpl as LooseRecord;

  if (!str(t.name)) collect(errors, "name-required", "name", "template name is required");
  if (typeof t.version !== "number" || !Number.isInteger(t.version) || t.version <= 0) {
    collect(errors, "version-invalid", "version", "version must be a positive integer");
  }

  // tiers：2~3 层、id 唯一、prompt 引用非空
  const tiers = Array.isArray(t.tiers) ? (t.tiers as LooseRecord[]) : undefined;
  if (!tiers) {
    collect(errors, "tiers-required", "tiers", "tiers array is required");
  } else {
    if (tiers.length < 2 || tiers.length > 3) {
      collect(errors, "tiers-length", "tiers", "template requires 2 to 3 tiers");
    }
    const ids = new Set<string>();
    tiers.forEach((tier, i) => {
      const p = `tiers[${i}]`;
      if (!str(tier?.id)) collect(errors, "tier-id-required", `${p}.id`, "tier id is required");
      else if (ids.has(tier.id as string)) {
        collect(errors, "tier-duplicate", `${p}.id`, `duplicate tier id: ${tier.id}`);
      } else ids.add(tier.id as string);
      if (!str(tier?.prompt)) collect(errors, "tier-prompt-required", `${p}.prompt`, "tier prompt is required");
    });
  }

  // roles：引用与覆盖形态
  const roles = Array.isArray(t.roles) ? t.roles : undefined;
  if (!roles || roles.length === 0) {
    collect(errors, "roles-required", "roles", "at least one role is required");
  } else {
    const seen = new Set<string>();
    roles.forEach((role, i) => {
      const p = `roles[${i}]`;
      const ref = typeof role === "string" ? role : (role as LooseRecord | null)?.ref;
      const overrideId = typeof role === "object" && role !== null ? (role as LooseRecord).id : undefined;
      const roleId = typeof ref === "string" ? ref : overrideId;
      if (!str(roleId)) {
        collect(errors, "role-ref-required", p, "role must reference a defined role id");
        return;
      }
      if (seen.has(roleId)) collect(errors, "role-duplicate", p, `duplicate role: ${roleId}`);
      seen.add(roleId);
    });
  }

  // comm_mode
  if (t.comm_mode !== undefined && t.comm_mode !== "auto" && t.comm_mode !== "explicit") {
    collect(errors, "comm-mode-invalid", "comm_mode", "comm_mode must be auto or explicit");
  }
  if (t.comm_mode === "explicit") {
    const comm = t.comm;
    if (!Array.isArray(comm)) {
      collect(errors, "explicit-comm-required", "comm", "explicit mode requires a comm whitelist array");
    } else {
      comm.forEach((edge, i) => {
        const e = edge as LooseRecord | null;
        if (
          typeof e !== "object" ||
          e === null ||
          !str(e.from) ||
          !str(e.to)
        ) {
          collect(errors, "comm-edge-invalid", `comm[${i}]`, "edge must have from/to");
        }
      });
    }
  }

  // archives：file|url 两型硬编码；file 型 target 相对路径
  if (t.archives !== undefined) {
    if (!Array.isArray(t.archives)) {
      collect(errors, "archives-not-array", "archives", "archives must be an array");
    } else {
      t.archives.forEach((arc, i) => {
        const p = `archives[${i}]`;
        const a = arc as LooseRecord | null;
        if (typeof a !== "object" || a === null || !str(a.id)) {
          collect(errors, "archive-id-required", `${p}.id`, "archive id is required");
          return;
        }
        if (a.type !== "file" && a.type !== "url") {
          collect(errors, "archive-type-invalid", `${p}.type`, "type must be file or url");
        }
        if (a.type === "file") {
          const target = a.target;
          if (!str(target)) {
            collect(errors, "archive-target-required", `${p}.target`, "file archive target is required");
          } else if (typeof target === "string" && (target.includes("..") || target.startsWith("/"))) {
            collect(errors, "archive-target-escapes", `${p}.target`, "file target must stay inside TEAM_HOME");
          }
        }
        if (a.type === "url" && !str(a.url)) {
          collect(errors, "archive-url-required", `${p}.url`, "url archive requires url field");
        }
      });
    }
  }

  // gates：at 引用 tier 存在
  if (t.gates !== undefined) {
    if (!Array.isArray(t.gates)) {
      collect(errors, "gates-not-array", "gates", "gates must be an array");
    } else {
      const tierIds = new Set((tiers ?? []).map((x) => x?.id as string).filter(Boolean));
      t.gates.forEach((gate, i) => {
        const p = `gates[${i}]`;
        const g = gate as LooseRecord | null;
        if (typeof g !== "object" || g === null || !str(g.id)) {
          collect(errors, "gate-id-required", `${p}.id`, "gate id is required");
          return;
        }
        if (!str(g.at) || !tierIds.has(g.at)) {
          collect(errors, "gate-at-unknown", `${p}.at`, `gate at references unknown tier: ${String(g.at)}`);
        }
        if (g.on !== undefined && !/^stage-enter:[a-z][a-z0-9_-]*$/.test(String(g.on))) {
          collect(errors, "gate-on-invalid", `${p}.on`, "on must look like stage-enter:<state>");
        }
      });
    }
  }

  // resources：正整数
  if (t.resources !== undefined) {
    if (typeof t.resources !== "object" || t.resources === null || Array.isArray(t.resources)) {
      collect(errors, "resources-not-object", "resources", "resources must be an object");
    } else {
      for (const [key, value] of Object.entries(t.resources as LooseRecord)) {
        if (key === "stages_ext") continue;
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
          collect(errors, "resource-invalid", `resources.${key}`, "resource limits must be positive integers");
        }
      }
    }
  }

  // stages_ext：不得与保留态冲突
  if (t.stages_ext !== undefined) {
    if (!Array.isArray(t.stages_ext)) {
      collect(errors, "stages-ext-not-array", "stages_ext", "stages_ext must be an array");
    } else {
      for (const stage of t.stages_ext) {
        if (!(RESERVED_STAGES as readonly string[]).includes(stage as string)) continue;
        collect(errors, "stage-reserved", "stages_ext", `stage conflicts with reserved: ${String(stage)}`);
      }
    }
  }

  // 来源标记：缺省通过（实例化快照强制注入），给了就必须合法
  if (t.source !== undefined && !(TEMPLATE_SOURCES as readonly string[]).includes(t.source as string)) {
    collect(errors, "source-invalid", "source", `source must be one of ${TEMPLATE_SOURCES.join("|")}`);
  }

  return { ok: errors.length === 0, errors };
}
