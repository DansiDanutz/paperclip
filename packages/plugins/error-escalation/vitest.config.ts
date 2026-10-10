import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@paperclipai/plugin-sdk/testing": path.resolve(__dirname, "../sdk/src/testing.ts"),
      "@paperclipai/plugin-sdk/ui": path.resolve(__dirname, "../sdk/src/ui/index.ts"),
      "@paperclipai/plugin-sdk": path.resolve(__dirname, "../sdk/src/index.ts"),
    },
  },
});
