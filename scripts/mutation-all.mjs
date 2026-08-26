#!/usr/bin/env node
/**
 * 本地全量变异入口：顺序跑 stryker.conf.d/ 下全部段配置并做聚合判分。
 * （issue #101 P4：原单份 stryker.conf.json 已退役，CI matrix 与本地共用
 * 同一份段清单，避免双套配置漂移。）
 *
 * fail-closed：任一段非零退出立即终止并透传退出码；全部成功后调
 * mutation-gate.mjs 聚合判分。
 */
import { spawnSync } from "node:child_process";
import { discoverSegments } from "./mutation-gate.mjs";

const segments = discoverSegments();
if (segments.length === 0) {
  console.error(`::error::stryker.conf.d 下没有任何段配置`);
  process.exit(1);
}
console.log(`段清单：${segments.join(", ")}`);

for (const seg of segments) {
  const conf = `stryker.conf.d/${seg}.json`;
  console.log(`\n=== [${seg}] stryker run ${conf} ===`);
  const result = spawnSync("pnpm", ["exec", "stryker", "run", conf], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`::error::段 ${seg} 变异运行失败（exit ${result.status ?? "signal"}）`);
    process.exit(result.status ?? 1);
  }
}

const gate = spawnSync("pnpm", ["exec", "node", "scripts/mutation-gate.mjs"], {
  stdio: "inherit",
});
process.exit(gate.status ?? 1);
