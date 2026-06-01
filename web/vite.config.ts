/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// Vanilla TS + Vite. No framework. Vitest config lives here too.
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
