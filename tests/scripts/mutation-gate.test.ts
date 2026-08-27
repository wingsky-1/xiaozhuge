/**
 * 变动段门禁的等价性与路由单元测试（issue #115）。
 *
 * 核心护栏：partial 合成口径必须与 full 全量聚合数学等价——当「未跑段的
 * 入库基线 === 其全量实跑结果」时（ci.yml 三档路由保证该前提），两种形态的
 * detected/covered/score 必须完全一致。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  countMutants,
  totalsFromReport,
  discoverSegments,
  segmentTotals,
} from "../../scripts/mutation-gate.mjs";
import {
  resolveRoute,
  compileGlob,
  discoverSegments as discoverRouteSegments,
} from "../../scripts/mutation-segments.mjs";

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
  vi.restoreAllMocks();
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

/* ================= issue #126 动态门禁等价性单测扩展 ================= */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const GATE_CLI = join(repoRoot, "scripts", "mutation-gate.mjs");
const SEGMENTS_CLI = join(repoRoot, "scripts", "mutation-segments.mjs");

/** #126 公共形参：段配置 / 报告 / 基线三根路径均指向临时目录。 */
const gateDirs = () => ({
  confDir: join(root, "stryker.conf.d"),
  reportDir: join(root, "reports", "mutation"),
  root,
});

/**
 * #126 P1 统一探针：stub process.exit 抛哨兵错误。
 * 既按验收口径断言退出码 1，又确保 fail-closed 流程真正中断而非继续放行；
 * stderr 文案同步收集，用于锁定 bail 因果（区分「报告缺失」与「基线缺失」等）。
 */
function failClosedProbe() {
  const exits: number[] = [];
  const errors: string[] = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exits.push(code as number);
    throw new Error(`__fail_closed_exit_${code}`);
  }) as never);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  return { exits, errors };
}

/** #126 P3 CLI 驱动：在指定目录 spawn gate 脚本，返回退出码与输出缓冲。 */
function runGateCli(cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, [GATE_CLI, ...args], { cwd, encoding: "utf8" });
}

/**
 * #126 P3 单段临时 fixture：conf.d/s.json 段名 + 实跑报告 s.json，
 * detected 个 Killed + (covered-detected) 个 Survived，分母可精确控制。
 */
function stageGateScenario(dir: string, detected: number, covered: number) {
  mkdirSync(join(dir, "stryker.conf.d"), { recursive: true });
  writeFileSync(join(dir, "stryker.conf.d", "s.json"), "{}");
  mkdirSync(join(dir, "reports", "mutation"), { recursive: true });
  const mutants = [
    ...Array.from({ length: detected }, () => ({ status: "Killed" })),
    ...Array.from({ length: covered - detected }, () => ({ status: "Survived" })),
  ];
  writeFileSync(
    join(dir, "reports", "mutation", "s.json"),
    JSON.stringify({ files: { "src/x/f.ts": { mutants } } }),
  );
}

describe("P1 fail-closed 正确性边界（#126，验收口径：exit 1）", () => {
  it("#126-P1-1 partial 模式下实跑段报告缺失 → exit 1", () => {
    // a 已列入 --ran 但 reports/mutation/a.json 不存在；b 基线齐全亦不得影响判定
    writeBaseline("b", mk(2, 1));
    const probe = failClosedProbe();
    expect(() => aggregate(new Set(["a"]), gateDirs())).toThrowError(/__fail_closed_exit_1$/);
    expect(probe.exits).toEqual([1]);
    expect(probe.errors.join(" ")).toContain("报告缺失");
  });

  it("#126-P1-2 partial 模式下未跑段基线缺失 → exit 1（合成判分不放行）", () => {
    // 实跑段 a 证据齐备，未跑段 b 仅缺入库基线：合成缺证据即拒绝
    writeReport("a", [mk(10, 2)]);
    const probe = failClosedProbe();
    expect(() => aggregate(new Set(["a"]), gateDirs())).toThrowError(/__fail_closed_exit_1$/);
    expect(probe.exits).toEqual([1]);
    expect(probe.errors.join(" ")).toContain("基线缺失");
  });

  it(
    "#126-P1-3 --ran 含未知段名 fail-closed（规格定义：未知段既无报告也无基线）",
    () => {
      // 段 a/b 的报告与基线全部就绪，排除「缺文件 bail」的混淆路径——
      // 若实现加了未知段校验，此处唯一失败原因只能是 ghost 检查本身触发 exit 1
      for (const seg of ["a", "b"]) {
        writeReport(seg, [mk(5, 1)]);
        writeBaseline(seg, mk(3, 1));
      }
      const probe = failClosedProbe();
      expect(() => aggregate(new Set(["ghost"]), gateDirs())).toThrowError(/__fail_closed_exit_1$/);
      expect(probe.exits).toEqual([1]);
    },
  );

  it("#126-P1-4 段配置不可读/为空时 discoverSegments 返回空且聚合不得放行", () => {
    // 场景审查结论：gate 层对空清单已显式 bail，「无段可跑误放行」不成立，本例锁死该链路
    const missingConf = join(root, "no-such-conf.d");
    const emptyConf = join(root, "empty-conf.d");
    mkdirSync(emptyConf);
    // discoverSegments 容错契约的一半：两入口均返回 [] 而非抛错
    expect(discoverSegments(missingConf)).toEqual([]);
    expect(discoverSegments(emptyConf)).toEqual([]);
    const probe = failClosedProbe();
    expect(() => aggregate(null, { ...gateDirs(), confDir: emptyConf })).toThrowError(
      /__fail_closed_exit_1$/,
    );
    expect(() => aggregate(new Set(["a"]), { ...gateDirs(), confDir: missingConf })).toThrowError(
      /__fail_closed_exit_1$/,
    );
    expect(probe.exits).toEqual([1, 1]);
    expect(probe.errors.join(" ")).toContain("没有任何段配置");
  });
});

describe("P2 路由边界（#126）", () => {
  it("#126-P2-5 仅 .d.ts 变更 → skip；与真源码混合时不稀释命中段", () => {
    const confDir = join(root, "stryker.conf.d");
    writeFileSync(join(confDir, "kernel.json"), JSON.stringify({ mutate: ["src/runtime/**/*.ts"] }));
    writeFileSync(join(confDir, "plugin.json"), JSON.stringify({ mutate: ["src/plugin/**/*.ts"] }));
    // 规范口径：isSrcFile 排除声明文件，纯类型变更无变异面 → skip
    expect(resolveRoute(["src/plugin/types.d.ts"], ["kernel", "plugin"], confDir)).toEqual({
      mode: "skip",
      segments: [],
    });
    // 补充锁定：.d.ts 不参与命中，路由只由真源码决定
    expect(resolveRoute(["src/plugin/types.d.ts", "src/plugin/h.ts"], ["kernel", "plugin"], confDir)).toEqual({
      mode: "partial",
      segments: ["plugin"],
    });
  });

  it("#126-P2-6 空变更清单 → skip（隐式覆盖转显式断言）", () => {
    expect(resolveRoute([], ["kernel", "plugin"])).toEqual({ mode: "skip", segments: [] });
  });

  it("#126-P2-7 --all CLI 分支输出 full 且全段与库层发现同源", () => {
    const out = spawnSync(process.execPath, [SEGMENTS_CLI, "--all"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out.status).toBe(0);
    // 与本地/CI 入口同源承诺：CLI 全量清单 === 库层 discoverSegments 结果
    expect(JSON.parse(out.stdout)).toEqual({
      mode: "full",
      segments: discoverRouteSegments(),
    });
  });
});

describe("P3 合成口径（#126）", () => {
  it("#126-P3-8 covered=0 → score=NaN → main 判分 bail exit 1", () => {
    // 库层：单段全部 mutant 不进口径（NoCoverage）时合成结果显式为 NaN
    rmSync(join(gateDirs().confDir, "b.json")); // 收敛单段夹具，排除无关段的证据需求
    writeReport("a", [mk(0, 0, 5)]);
    const r = aggregate(new Set(["a"]), gateDirs());
    expect(r.detected).toBe(0);
    expect(r.covered).toBe(0);
    expect(r.score).toBeNaN();
    // CLI 层：main 中 !(NaN >= threshold) 必须走 fail-closed bail
    const dir = join(root, "cli-zero");
    stageGateScenario(dir, 0, 0);
    const out = runGateCli(dir);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("::error::");
    expect(out.stderr).toContain("NaN");
  });

  it("#126-P3-9 缺省 ran=null（full 形态）与显式 --ran 全段逐字段一致", () => {
    writeReport("a", [mk(10, 2)]);
    writeReport("b", [mk(7, 3)]);
    const full = aggregate(null, gateDirs());
    // 显式清单与 discoverSegments 同源取段，禁止手抄段名漂移
    const explicit = aggregate(
      new Set(discoverSegments(gateDirs().confDir)),
      gateDirs(),
    );
    expect(explicit).toEqual(full); // rows/detected/covered/score 全等，source 均为 report
  });

  it("#126-P3-10 边界分数：恰达 70 放行、阈值高于分数即拒、边界下方拒绝", () => {
    // 分母受控构造：7/10 恰为 70.00；51/73 ≈ 69.863 为边界下方样本
    const at = join(root, "cli-at-threshold");
    stageGateScenario(at, 7, 10);
    const pass = runGateCli(at);
    expect(pass.status).toBe(0);
    expect(pass.stdout).toContain("门禁通过");
    // ≥ 语义的严格侧：分数恰等于默认阈值时，阈值仅上浮一点即应拒绝
    const strict = runGateCli(at, ["70.001"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).not.toContain("门禁通过");
    const below = join(root, "cli-below");
    stageGateScenario(below, 51, 73);
    const reject = runGateCli(below);
    expect(reject.status).toBe(1);
    expect(reject.stdout).not.toContain("门禁通过");
  });
});

describe("P4 导出函数结构直测（#126）", () => {
  it("#126-P4-11a segmentTotals 双源路由：ran 命中取报告、未命中回退基线", () => {
    // 基线与报告计数刻意不同：source 字段必须如实反映计数真正来源
    writeReport("a", [mk(4, 2)]);
    writeBaseline("a", mk(1, 1));
    expect(segmentTotals("a", new Set(["a"]), gateDirs())).toEqual({
      detected: 4,
      covered: 6,
      source: "report",
    });
    // 空 ran 集合 → 一切按未跑处理全走基线（与 aggregate 空集合语义一致）
    expect(segmentTotals("a", new Set(), gateDirs())).toEqual({
      detected: 1,
      covered: 2,
      source: "baseline",
    });
  });

  it("#126-P4-11b aggregate rows 顺序锁定为 discoverSegments 排序（与写盘顺序无关）", () => {
    // 以 b→a 的创建顺序重建段配置：readdir 平台序不可依赖，排序必须确定化
    rmSync(join(root, "stryker.conf.d"), { recursive: true });
    mkdirSync(gateDirs().confDir, { recursive: true });
    for (const seg of ["b", "a"]) {
      writeFileSync(join(gateDirs().confDir, `${seg}.json`), "{}");
    }
    writeBaseline("a", [mk(5, 5)]);
    writeBaseline("b", [mk(6, 4)]);
    // 空 ran 集合 = 全部按未跑处理走基线，避免 full 形态需要实跑报告
    const r = aggregate(new Set(), gateDirs());
    expect(r.rows.map((x) => x.seg)).toEqual(["a", "b"]);
    expect(r.rows.map((x) => x.seg)).toEqual(discoverSegments(gateDirs().confDir));
  });
});


