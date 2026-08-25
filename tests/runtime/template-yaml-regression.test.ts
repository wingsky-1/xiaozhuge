/**
 * 存量模板 YAML 可解析性回归（#29 第 B 项迁移步骤 1）。
 *
 * 合法 JSON ≠ 全部合法 YAML（如 tab 缩进的 JSON 不是合法 YAML）——
 * 切换到完整 YAML 解析器前，用回归数据确认包内置模板全部可被
 * `yaml`（eemeli）解析，而非凭断言。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const TEMPLATES_ROOT = join(REPO_ROOT, "templates");

/** 递归收集目录下全部 .yaml/.yml 文件。 */
function collectYamlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectYamlFiles(full));
    } else if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
      out.push(full);
    }
  }
  return out;
}

describe("存量模板 YAML 可解析性回归", () => {
  const files = collectYamlFiles(TEMPLATES_ROOT);

  it("templates/ 下存在模板文件（防回归空转）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(REPO_ROOT.length + 1), f]))(
    "%s 可被 yaml 解析且为映射",
    (_rel, full) => {
      const doc = parseYaml(readFileSync(full, "utf8")) as unknown;
      expect(doc).toBeTypeOf("object");
      expect(doc).not.toBeNull();
      expect(Array.isArray(doc)).toBe(false);
    },
  );

  it("无 tab 缩进（YAML 硬禁区，JSON 兼容子集时代的潜在陷阱）", () => {
    for (const f of files) {
      expect(readFileSync(f, "utf8")).not.toMatch(/^\t/m);
    }
  });
});
