// Script de migración. Corre con credenciales de administrador
// (MIGRATIONS_DATABASE_URL, rol cma_admin) — nunca con el rol de
// aplicación. Uso: `npm run db:migrate`.
//
// Hace dos cosas:
//   1. Aplica las migraciones de esquema generadas por drizzle-kit.
//   2. Crea/ajusta el rol restringido de runtime (cma_app) y sus
//      permisos, para que la aplicación físicamente no pueda hacer
//      UPDATE/DELETE sobre evidencia ni sobre el log de auditoría
//      (SI-002, SI-003, SI-043; rules/security-privacy.md regla 5;
//      docs/SECURITY.md "Nunca eliminar registros de auditoría").
//
// Esto solo funciona porque cma_admin (dueño de las tablas) es distinto
// de cma_app: en Postgres el dueño de una tabla siempre puede
// UPDATE/DELETE sin importar los GRANT, así que la separación de roles
// no es opcional, es la única forma de que la restricción sea real y no
// solo una convención de código.

import { config } from "../../shared/config.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EVIDENCE_TABLES = [
  "conversations",
  "participants",
  "messages",
  "attachments",
];
const AUDIT_TABLE = "system_audit_log";
const REGENERABLE_TABLES = [
  "sources",
  "import_jobs",
  "cases",
  "events",
  "event_messages",
  "insights",
  "relationships",
  "message_entities",
  "message_metadata",
  "message_processing_state",
  "analyses",
  "observations",
  "summaries",
  "embeddings",
  "reminders",
  "drafts",
  "suggestions",
];

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function applyAppRolePolicies(client: Client): Promise<void> {
  if (!config.appDbPassword) {
    console.warn(
      "APP_DB_PASSWORD no definido — se omite crear/ajustar el rol " +
        "restringido cma_app. No corras la aplicación contra el rol admin."
    );
    return;
  }

  console.log("Aplicando políticas del rol de aplicación (cma_app)...");
  const escapedPassword = config.appDbPassword.replace(/'/g, "''");

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'cma_app') THEN
        CREATE ROLE cma_app LOGIN PASSWORD '${escapedPassword}';
      ELSE
        ALTER ROLE cma_app LOGIN PASSWORD '${escapedPassword}';
      END IF;
    END
    $$;
  `);

  const dbNameResult = await client.query<{ name: string }>(
    "SELECT current_database() AS name"
  );
  const dbName = dbNameResult.rows[0]?.name;
  if (!dbName) {
    throw new Error("No se pudo determinar la base de datos actual.");
  }

  await client.query(
    `GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO cma_app;`
  );
  await client.query(`GRANT USAGE ON SCHEMA public TO cma_app;`);

  // Evidencia + auditoría: solo lectura + inserción. Nunca UPDATE/DELETE.
  const readInsertOnly = [...EVIDENCE_TABLES, AUDIT_TABLE];
  await client.query(
    `GRANT SELECT, INSERT ON ${readInsertOnly
      .map(quoteIdent)
      .join(", ")} TO cma_app;`
  );

  // Conocimiento y artefactos derivados: regenerables, CRUD completo.
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${REGENERABLE_TABLES.map(
      quoteIdent
    ).join(", ")} TO cma_app;`
  );

  console.log(
    "cma_app: SELECT+INSERT en evidencia/auditoría; CRUD completo en " +
      "conocimiento/artefactos derivados."
  );
}

/**
 * Aplica extensión + migraciones + políticas del rol de aplicación sobre
 * la conexión dada (`client` ya debe estar conectado). Reusado por
 * `main()` (DB de desarrollo) y por los integration tests
 * (`src/infrastructure/db/test-db.ts`, DB de test efímera) para no
 * duplicar esta lógica entre ambos.
 */
export async function runMigrationsAndPolicies(client: Client): Promise<void> {
  // La extensión debe existir ANTES de correr las migraciones: la tabla
  // `embeddings` usa el tipo `vector`, que no existe hasta que se crea
  // la extensión.
  console.log("Asegurando extensión pgvector...");
  await client.query("CREATE EXTENSION IF NOT EXISTS vector;");

  console.log("Aplicando migraciones de esquema...");
  const db = drizzle(client);
  const migrationsFolder = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "migrations"
  );
  await migrate(db, { migrationsFolder });

  await applyIndexesNotExpressibleInSchema(client);
  await applyAppRolePolicies(client);
}

/**
 * Índices que Drizzle no puede declarar en `schema.ts` porque dependen de
 * una expresión, no de columnas. Van acá por el mismo motivo que la
 * extensión `vector` y los GRANT del rol de aplicación: es DDL real del
 * esquema que el generador de migraciones no produce.
 *
 * Todos son `IF NOT EXISTS`, así que la función es idempotente y puede
 * correrse en cada `db:migrate` sin efectos.
 */
async function applyIndexesNotExpressibleInSchema(client: Client): Promise<void> {
  console.log("Asegurando índices de búsqueda...");

  // Q-EX-02 (búsqueda por texto literal, docs/QUERY_CATALOG.md). El
  // diccionario 'spanish' aplica stemming y stopwords del castellano: sin
  // él, buscar "vacaciones" no encontraría "vacación" y la búsqueda
  // exacta quedaría coja en el idioma real de la conversación. El índice
  // debe usar EXACTAMENTE la misma expresión que la consulta, o Postgres
  // no lo usa y cae a un scan secuencial sobre todos los mensajes.
  await client.query(`
    CREATE INDEX IF NOT EXISTS messages_content_fts_idx
      ON messages
      USING GIN (to_tsvector('spanish', content));
  `);

  // Q-EX-01/Q-EX-04 y toda la cronología (Q-TL-*) filtran y ordenan por
  // fecha dentro de una conversación.
  await client.query(`
    CREATE INDEX IF NOT EXISTS messages_conversation_sent_at_idx
      ON messages (conversation_id, sent_at);
  `);

  // Q-EX-03 (mensajes por participante).
  await client.query(`
    CREATE INDEX IF NOT EXISTS messages_participant_sent_at_idx
      ON messages (participant_id, sent_at);
  `);

  // Q-TL-01/Q-TL-02: eventos de un Case en orden cronológico.
  await client.query(`
    CREATE INDEX IF NOT EXISTS events_case_occurred_at_idx
      ON events (case_id, occurred_at);
  `);

  // Q-EV-03: los artefactos derivados se buscan por su sujeto polimórfico.
  await client.query(`
    CREATE INDEX IF NOT EXISTS analyses_subject_idx
      ON analyses (subject_type, subject_id);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS observations_subject_idx
      ON observations (subject_type, subject_id);
  `);

  // Q-SEM-01/02 (Semantic Search, docs/DECISIONS.md "Embeddings:
  // proveedor, modelo, chunking, top-k y regeneración"). HNSW en vez de
  // ivfflat: no necesita un parámetro `lists` calibrado al tamaño de la
  // tabla (que hoy empieza vacía y crece), y la imagen del proyecto
  // (pgvector/pgvector:pg16, ver docker-compose.yml) trae pgvector 0.8.x,
  // muy por encima del mínimo 0.5.0 que introdujo HNSW. `vector_cosine_ops`
  // porque las consultas usan distancia coseno (`<=>`) — debe coincidir
  // con el operador que usa src/search/queries/semantic-search.ts o
  // Postgres no usa el índice.
  await client.query(`
    CREATE INDEX IF NOT EXISTS embeddings_vector_hnsw_idx
      ON embeddings
      USING hnsw (vector vector_cosine_ops);
  `);

  // Filtro previo a la distancia vectorial: subject_type siempre se fija
  // (Message/Event/Case/...) y model+dims identifican la versión vigente
  // del embedding cuando conviven varias generaciones en la misma tabla
  // (SI-028: nunca se hace UPDATE, se inserta una fila nueva).
  await client.query(`
    CREATE INDEX IF NOT EXISTS embeddings_subject_model_dims_idx
      ON embeddings (subject_type, model, dims);
  `);
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: config.migrationsDatabaseUrl });
  await client.connect();

  try {
    await runMigrationsAndPolicies(client);
    console.log("Migración completa.");
  } finally {
    await client.end();
  }
}

// Solo corre `main()` cuando este archivo se ejecuta directamente
// (`npm run db:migrate`), nunca al importar `runMigrationsAndPolicies`
// desde otro módulo (src/infrastructure/db/test-db.ts) — de lo
// contrario, importar esta función dispararía una migración real contra
// `MIGRATIONS_DATABASE_URL` (la base de desarrollo) como efecto
// secundario del import.
const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
