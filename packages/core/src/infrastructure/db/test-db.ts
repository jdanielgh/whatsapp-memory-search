// Infraestructura de integration tests (rules/dev-style.md, regla 4):
// una base de datos de test efímera, derivada de las mismas credenciales
// que la de desarrollo pero con un nombre distinto (sufijo `_test`) en el
// mismo servidor Postgres. Nunca toca la base de desarrollo (que ya
// tiene evidencia real, sin DELETE posible) — se crea, se migra y se
// trunca libremente porque es enteramente descartable.

import { Client } from "pg";
import { config } from "../../shared/config.js";
import { runMigrationsAndPolicies } from "./migrate.js";

function deriveTestUrl(url: string): string {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName) {
    throw new Error(`No se pudo determinar el nombre de base de datos en "${url}".`);
  }
  parsed.pathname = `/${dbName}_test`;
  return parsed.toString();
}

/** URL de administrador (cma_admin) contra la base de datos de test. */
export const testMigrationsDatabaseUrl = deriveTestUrl(config.migrationsDatabaseUrl);
/** URL de aplicación (cma_app) contra la base de datos de test. */
export const testDatabaseUrl = deriveTestUrl(config.databaseUrl);

async function ensureTestDatabaseExists(): Promise<void> {
  const testDbUrl = new URL(testMigrationsDatabaseUrl);
  const testDbName = testDbUrl.pathname.replace(/^\//, "");

  // No se puede CREATE DATABASE estando conectado a esa misma base — hay
  // que conectarse primero a la base de mantenimiento `postgres`.
  const maintenanceUrl = new URL(testMigrationsDatabaseUrl);
  maintenanceUrl.pathname = "/postgres";

  const client = new Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [testDbName]
    );
    if (rows.length === 0) {
      // El nombre viene de config (no de input externo/usuario), así que
      // no hay riesgo real de inyección — se escapa el identificador de
      // todas formas porque CREATE DATABASE no admite parámetros ($1).
      await client.query(`CREATE DATABASE "${testDbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

async function applySchema(): Promise<void> {
  const client = new Client({ connectionString: testMigrationsDatabaseUrl });
  await client.connect();
  try {
    await runMigrationsAndPolicies(client);
  } finally {
    await client.end();
  }
}

/** Se corre una vez antes de toda la suite de integración (vitest globalSetup). */
export async function setupTestDatabase(): Promise<void> {
  await ensureTestDatabaseExists();
  await applySchema();
}

/**
 * Trunca todas las tablas de la base de TEST (nunca la de desarrollo)
 * para dejarla limpia entre archivos/casos de integration test. Usa el
 * rol admin porque cma_app no tiene permiso de DELETE sobre evidencia
 * ni siquiera acá — la restricción es intencionalmente absoluta, así
 * que la limpieza entre tests pasa por la conexión de administrador,
 * igual que en producción pasaría por una restauración de backup, nunca
 * por el rol de runtime.
 */
export async function resetTestDatabase(): Promise<void> {
  const client = new Client({ connectionString: testMigrationsDatabaseUrl });
  await client.connect();
  try {
    // Las tablas de conocimiento se listan explícitamente y no se
    // confía en el CASCADE: `analyses`, `observations`, `summaries` y
    // `embeddings` referencian a su sujeto de forma polimórfica
    // (subject_type/subject_id) y por lo tanto NO tienen foreign key, así
    // que un TRUNCATE CASCADE desde `conversations` no las alcanza y sus
    // filas sobreviven de una corrida de tests a la siguiente. Eso hace
    // que un test pase o falle según qué se haya corrido antes.
    await client.query(`
      TRUNCATE TABLE
        attachments, messages, participants, conversations,
        import_jobs, sources, system_audit_log,
        cases, events, event_messages, insights, relationships,
        message_entities, message_metadata, message_processing_state,
        analyses, observations, summaries, embeddings,
        reminders, drafts, suggestions
      RESTART IDENTITY CASCADE;
    `);
  } finally {
    await client.end();
  }
}
