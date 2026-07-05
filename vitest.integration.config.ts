import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integrationstests gegen ECHTES git in Temp-Verzeichnissen.
// Bewusst NICHT Teil von `npm test` — Aufruf: `npm run test:integration`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30_000, // git-Subprozesse: großzügiges Limit für langsame CI-Runner
  },
  resolve: {
    alias: {
      // Gleicher Mock-Alias wie in vitest.config.ts (git-port.ts importiert Platform):
      obsidian: fileURLToPath(new URL("./tests/__mocks__/obsidian.ts", import.meta.url)),
    },
  },
});
