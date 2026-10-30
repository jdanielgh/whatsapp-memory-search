import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    // Sin cobertura obligatoria global (rules/dev-style.md): tests
    // obligatorios en whatsapp-ingest, rag-retrieval, y los repositorios
    // de archive/ (esos últimos como integration test, ver
    // vitest.integration.config.ts — necesitan Postgres real).
  },
});
