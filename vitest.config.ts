import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // 0.1.2：dsh-client-runtime 已删；客户端仅 type-only import 官方契约包
      // （session-controller / ui-conversation），esbuild 擦除 type import 后
      // 无运行时依赖；jsdom 行为测试经官方服务方法面（ctx.sessions.scope 等）
      // fake，无需包级替身——此处仅保留兜底 alias（当前无消费方）。
      "@deepseek-ai/dsh-api-session-controller/client": fileURLToPath(
        new URL("./tests/client/stubs/session-controller-client.ts", import.meta.url),
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
