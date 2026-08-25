import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // 浏览器端插件（src/client）不在 node vitest 环境运行：契约由
      // scripts/verify-client.mjs + team-launch.test.ts 源码断言保障，排除出覆盖率。
      exclude: ["src/client/**", "src/**/*.d.ts"],
      // text 供人读；cobertura 供 diff-cover 增量门禁消费（#30）。
      reporter: ["text", "cobertura"],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
