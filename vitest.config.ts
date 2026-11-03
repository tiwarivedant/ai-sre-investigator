import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  // Tests save investigations to their own folder, never to your .investigations/.
  test: { include: ["**/*.test.ts"], exclude: ["node_modules/**", "e2e/**"], env: { INVESTIGATIONS_DIR: ".investigations-test" } },
});
