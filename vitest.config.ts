import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["tsconfig.dev.json"] })],
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // 虚拟时钟把 30 天压成秒级；单测本身必须很快
    testTimeout: 20_000,
    reporters: ["default"],
  },
});
