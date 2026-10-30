import { defineConfig } from "vitest/config";

// Integration tests (rules/dev-style.md, regla 4): repositorios de
// archive/ contra Postgres real (base de datos de test efímera, nunca
// la de desarrollo — ver src/infrastructure/db/test-db.ts). Requieren
// Docker/Postgres arriba (`npm run db:up`) y un `.env` válido.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    globalSetup: ["./src/infrastructure/db/integration-global-setup.ts"],
    // Todos los integration tests comparten una sola base de datos de
    // test: correrlos en paralelo produciría condiciones de carrera
    // sobre las mismas tablas.
    fileParallelism: false,
    // Los E2E que spawnean `npm run sync` como proceso real (arranque de
    // npm/tsx incluido) son más lentos que una query directa — el
    // default de 5s de vitest no alcanza. En Windows, el E2E que lanza
    // tres procesos npm seguidos ronda los 27-33s cuando se corre desde
    // la raíz del monorepo (un nivel más de npm), así que 30s quedaba al
    // borde.
    testTimeout: 60_000,
  },
});
