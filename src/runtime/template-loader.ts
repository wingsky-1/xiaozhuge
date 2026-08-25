/**
 * 模板加载原语（P6a，ADR 0005/#13 三级来源口径）。
 *
 * 解析决策（#29 第 B 项）：模板内容为完整 YAML 1.2，由成熟解析器
 * `yaml`（eemeli，零传递依赖）读取——注释/块标量/锚点全量可用；
 * 此前的 JSON 兼容子集（issue #10 MVP 留痕）已被该 approved 决策取代。
 *
 * 来源三级：builtin（包内只读）/ user / project——同名不跨级覆盖，
 * 加载时标记来源即可区分（#13 冻结口径）。
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { TemplateSource } from "./types.js";
import { validateTeamTemplate, validateRoleSet } from "./template.js";

/** 模板场景目录内的固定文件名（v2.2 定稿 §7.1）。 */
export const TEAM_FILE = "team.yaml";
export const ROLES_DIR = "roles";
export const PROMPTS_DIR = "prompts";

export interface LoadedTemplate {
  /** team.yaml 解析结果（已通过校验）。 */
  template: Record<string, unknown> & {
    name: string;
    version: number;
    source?: TemplateSource;
  };
  /** role id -> Role Spec 对象（已通过集合校验）。 */
  roles: Record<string, Record<string, unknown>>;
  /** role/tier id -> prompt 文本（相对路径 -> 内联文本）。 */
  prompts: Record<string, string>;
  /** 来源标记。 */
  source: TemplateSource;
  /** 模板内容摘要（sha256，前 16 位）。 */
  digest: string;
}

/**
 * 从场景目录加载并校验模板。
 * @throws Error 目录缺失 / YAML 解析失败 / 校验不通过。
 */
export async function loadTemplate(
  scenarioDir: string,
  source: TemplateSource,
): Promise<LoadedTemplate> {
  const teamPath = join(scenarioDir, TEAM_FILE);
  if (!existsSync(teamPath)) {
    throw new Error(`template missing ${TEAM_FILE} in ${scenarioDir}`);
  }
  const teamRaw = await readFile(teamPath, "utf8");
  let template: Record<string, unknown> & { name: string; version: number; source?: TemplateSource };
  try {
    const parsed = parseYaml(teamRaw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("document must be a mapping");
    }
    template = parsed as typeof template;
  } catch (error) {
    throw new Error(`template ${teamPath} is not valid YAML: ${(error as Error).message}`);
  }

  // 强制注入来源标记（覆盖模板自带值——来源由加载位置决定，不由文件内容决定）。
  template.source = source;

  const rolesDir = join(scenarioDir, ROLES_DIR);
  const specs: Array<Record<string, unknown>> = [];
  const roles: Record<string, Record<string, unknown>> = {};
  if (existsSync(rolesDir)) {
    for (const entry of (await readFile2(rolesDir)).sort()) {
      if (!entry.endsWith(".role.yaml")) continue;
      const spec = parseYaml(await readFile(join(rolesDir, entry), "utf8")) as Record<string, unknown>;
      specs.push(spec);
      roles[String(spec.id)] = spec;
    }
  }

  // 校验：模板 + 角色集合（一次收集全部错误后统一抛出）。
  const tplResult = validateTeamTemplate(template);
  const setResult = validateRoleSet(specs);
  const allErrors = [
    ...tplResult.errors.map((e) => ({ ...e, path: `team.${e.path}` })),
    ...setResult.errors.map((e) => ({ ...e, path: `roles.${e.path}` })),
  ];
  if (allErrors.length > 0) {
    throw new Error(
      `template validation failed:\n${allErrors.map((e) => `- [${e.code}] ${e.path}: ${e.message}`).join("\n")}`,
    );
  }

  // prompt 内联：读 prompts/ 下被引用的文本（缺失即抛——实例化完整性硬约束）。
  const prompts: Record<string, string> = {};
  const referenced = new Set<string>();
  for (const tier of (template.tiers as Array<{ prompt?: string }>) ?? []) {
    if (typeof tier.prompt === "string") referenced.add(tier.prompt);
  }
  for (const spec of specs) {
    const p = (spec as { prompt?: unknown }).prompt;
    if (typeof p === "string") referenced.add(p);
  }
  for (const rel of referenced) {
    const promptPath = join(scenarioDir, rel);
    if (!existsSync(promptPath)) {
      throw new Error(`referenced prompt missing: ${rel}`);
    }
    prompts[rel] = await readFile(promptPath, "utf8");
  }

  return {
    template,
    roles,
    prompts,
    source,
    digest: createHash("sha256").update(JSON.stringify({ template, roles })).digest("hex").slice(0, 16),
  };
}

async function readFile2(dir: string): Promise<string[]> {
  return readdir(dir);
}

/** 实例化快照：模板 + 角色 + 来源标记 + digest（写入 TEAM_HOME/team.yaml 的对象）。 */
export function instantiateSnapshot(loaded: LoadedTemplate): Record<string, unknown> {
  return {
    name: loaded.template.name,
    version: loaded.template.version,
    source: loaded.source,
    digest: loaded.digest,
    tiers: loaded.template.tiers,
    roles: Object.values(loaded.roles).map((r) => ({
      id: r.id,
      prompt_inlined: loaded.prompts[String(r.prompt)] ?? null,
      briefing: r.briefing ?? null,
      dod: r.dod ?? [],
      max_hops: r.max_hops ?? 3,
      as_judge: r.as_judge === true,
    })),
    instantiated_at: Date.now(),
  };
}

/** 便捷：包内置只读模板目录（builtin 来源）。 */
export function builtinScenarioDir(packageRoot: string): string {
  return join(packageRoot, "templates", "oss-maintenance");
}
