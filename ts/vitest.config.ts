import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "parley-protocol/examples": fileURLToPath(new URL("./src/examples/index.ts", import.meta.url)),
      "parley-protocol": fileURLToPath(new URL("./src/index.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
