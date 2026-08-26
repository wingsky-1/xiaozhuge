/**
 * 变动段门禁的等价性与路由单元测试（issue #115）。
 *
 * 核心护栏：partial 合成口径必须与 full 全量聚合数学等价——当「未跑段的
 * 入库基线 === 其全量实跑结果」时（ci.yml 三档路由保证该前提），两种形态的
 * detected/covered/score 必须完全一致。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregate,
  countMutants,
  totalsFromReport,
  discoverSegments,
} from "../../scripts/mutation-gate.mjs";
import { resolveRoute, compileGlob } from "../../scripts/mutation-segments.mjs";

let root: string;

function writeReport(seg: string, perFile: Array<Array<{ status: string }>>) {
  const files: Record<string, { mutants: Array<{ status: string }> }> = {};
  for (const [i, mutants] of perFile.entries()) {
    files[`src/x/f${i}.ts`] = { mutants };
  }
  const dir = join(root, "reports", "mutation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${seg}.json`), JSON.stringify({ files }));
}

function writeBaseline(seg: string, mutants: Array<{ status: string }>) {
  writeFileSync(join(root, `stryker-incremental-${seg}.json`), JSON.stringify({ files: { "src/x/b.ts": { mutants } } }));
}

/** 构造一份 mutants：detected 个 Killed + survived 个 Survived + nc 个 NoCoverage。 */
const mk = (detected: number, survived: number, noCov = 0) => [
  ...Array.from({ length: detected }, () => ({ status: "Killed" })),
  ...Array.from({ length: survived }, () => ({ status: "Survived" })),
  ...Array.from({ length: noCov }, () => ({ status: "NoCoverage" })),
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "xzg-gate-"));
  mkdirSync(join(root, "stryker.conf.d"), { recursive: true });
  for (const seg of ["a", "b"]) {
    writeFileSync(join(root, "stryker.conf.d", `${seg}.json`), "{}");
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("countMutants / totalsFromReport", () => {
  it("PascalCase 状态计数对齐 covered 口径定义", () => {
    expect(countMutants([
      { status: "Killed" },
      { status: "Timeout" },
      { status: "Survived" },
      { status: "Ignored" },
      { status: "NoCoverage" },
      { status: "RuntimeError" },
    ])).toEqual({ detected: 2, covered: 4 });
  });

  it("空 files 与缺失 mutants 数组均判为结构异常", () => {
    expect(totalsFromReport({ files: {} })).toBeNull();
    expect(totalsFromReport({ files: { "a.ts": {} } })).toBeNull();
  });
});

describe("resolveRoute 三档路由", () => {
  const segments = ["kernel", "plugin"];

  it("docs-only → skip", () => {
    expect(resolveRoute(["README.md", "docs/x.md"], segments)).toEqual({ mode: "skip", segments: [] });
  });

  it("tests 变更 → full 回退（Vitest 测试追踪仅文件级粒度）", () => {
    expect(resolveRoute(["src/plugin/a.ts", "tests/plugin/a.test.ts"], segments)).toEqual({
      mode: "full",
      segments,
    });
  });

  it("仅 src 变更 → partial 且只命中覆盖该文件的段", () => {
    const confDir = join(root, "stryker.conf.d");
    // a.json 覆盖 src/runtime/**；b.json 覆盖 src/plugin/**
    writeFileSync(join(confDir, "kernel.json"), JSON.stringify({ mutate: ["src/runtime/**/*.ts"] }));
    writeFileSync(join(confDir, "plugin.json"), JSON.stringify({ mutate: ["src/plugin/**/*.ts"] }));
    const r = resolveRoute(["src/plugin/handlers.ts"], ["kernel", "plugin"], confDir);
    expect(r).toEqual({ mode: "partial", segments: ["plugin"] });
  });

  it("src 变更无段命中（配置漂移）→ fail-safe 回退 full", () => {
    const confDir = join(root, "stryker.conf.d");
    writeFileSync(join(confDir, "kernel.json"), JSON.stringify({ mutate: ["src/runtime/**/*.ts"] }));
    writeFileSync(join(confDir, "plugin.json"), JSON.stringify({ mutate: ["src/plugin/**/*.ts"] }));
    expect(resolveRoute(["src/client/x.ts"], ["kernel", "plugin"], confDir)).toEqual({
      mode: "full",
      segments,
    });
  });
});

describe("partial 合成与 full 聚合的等价性（核心护栏）", () => {
  const dirs = () => ({ confDir: join(root, "stryker.conf.d"), reportDir: join(root, "reports", "mutation"), root });

  beforeEach(() => {
    // 段 a 实跑新报告：detected 10 / covered 12
    writeReport("a", [mk(10, 2)]);
    // 段 b 实跑新报告与入库基线一致：detected 7 / covered 10（+NoCoverage 不进口径）
    writeReport("b", [mk(7, 3)]);
    writeBaseline("b", mk(7, 3));
  });

  it("未跑段基线 === 其全量结果时，partial 合成 === full 聚合", () => {
    const full = aggregate(null, dirs());
    const partial = aggregate(new Set(["a"]), dirs());
    expect(partial.detected).toBe(full.detected);
    expect(partial.covered).toBe(full.covered);
    expect(partial.score).toBeCloseTo(full.score, 10);
    expect(full.rows.find((r) => r.seg === "b")!.source).toBe("report");
    expect(partial.rows.find((r) => r.seg === "b")!.source).toBe("baseline");
  });

  it("实跑段分数变化只通过该段传导进全局合成", () => {
    writeReport("a", [mk(6, 6)]); // 段 a 劣化：10/12 → 6/12
    const partial = aggregate(new Set(["a"]), dirs());
    // 合成 = a(6+6) + b 基线(7+3)
    expect(partial.detected).toBe(13);
    expect(partial.covered).toBe(22);
  });

  it("discoverSegments 按文件名排序推导", () => {
    expect(discoverSegments(join(root, "stryker.conf.d"))).toEqual(["a", "b"]);
  });
});
