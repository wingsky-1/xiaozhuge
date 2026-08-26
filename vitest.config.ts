import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // runtime/client 是 __ModuleLoader__ 契约外壳 bundle，node 测试环境
      // 不可加载；tests/client 行为测试经此替身按官方语义寻址（见 stub 内注释）。
      "@deepseek-ai/dsh-client-runtime/client": fileURLToPath(
        new URL("./tests/client/stubs/runtime-client.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // 浏览器端插件（src/client）中 index.tsx 已有 jsdom 行为测试
      // （tests/client/）；team-view 为画布组件暂无渲染测试，仍排除。
      exclude: ["src/client/team-view.tsx", "src/**/*.d.ts"],
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
