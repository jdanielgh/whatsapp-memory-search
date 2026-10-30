// drizzle-kit siempre corre con cwd = packages/core (`npm run db:* -w
// @cma/core`); el .env vive en la raíz del monorepo.
import { config } from "dotenv";
config({ path: "../../.env" });
import { defineConfig } from "drizzle-kit";

// drizzle-kit necesita el rol admin (dueño de las tablas), nunca el rol
// de aplicación restringido — ver docker-compose.yml y .env.example.
const migrationsDatabaseUrl =
  process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
if (!migrationsDatabaseUrl) {
  throw new Error(
    "MIGRATIONS_DATABASE_URL no está definida. Copia .env.example a .env y complétala."
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/db/schema.ts",
  out: "./src/infrastructure/db/migrations",
  dbCredentials: {
    url: migrationsDatabaseUrl,
  },
  strict: true,
  verbose: true,
});
