// Único punto de lectura de variables de entorno (plans/,
// tarea 4). Ningún otro módulo debe leer process.env directamente.

import "./load-env.js";
import path from "node:path";
import { parseParticipantRoles } from "./participant-roles.js";
import { DEFAULT_AI_PROVIDER, DEFAULT_EMBEDDING_PROVIDER } from "./provider-defaults.js";
import { REPO_ROOT } from "./repo-paths.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Ver .env.example.`);
  }
  return value;
}

function optionalNumber(name: string): number | null {
  const value = process.env[name];
  if (!value) return null;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} debe ser numérico, recibido: "${value}".`);
  }
  return parsed;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  migrationsDatabaseUrl:
    process.env.MIGRATIONS_DATABASE_URL ?? required("DATABASE_URL"),
  appDbPassword: process.env.APP_DB_PASSWORD ?? null,

  // Motores de IA (plans/). Los nombres válidos los define
  // el registro de proveedores (infrastructure/ai/factory.ts); un nombre
  // desconocido falla explícito al crear el proveedor. Los overrides por tier
  // permiten, por ejemplo, otro motor solo para Entity Detection.
  aiProvider: process.env.AI_PROVIDER || DEFAULT_AI_PROVIDER,
  aiProviderCheap: process.env.AI_PROVIDER_CHEAP || null,
  aiProviderDefault: process.env.AI_PROVIDER_DEFAULT || null,
  embeddingProvider: process.env.EMBEDDING_PROVIDER || DEFAULT_EMBEDDING_PROVIDER,

  // Motor `claude-code` (suscripción). Los modelos son específicos de cada
  // motor, por eso no reutilizan AI_MODEL_*: con un override por tier podrían
  // convivir dos motores con nombres de modelo distintos. Alias (`haiku`,
  // `sonnet`) apuntan al más reciente y cambian con el tiempo; para resultados
  // reproducibles conviene fijar un ID explícito.
  claudeCodeModelCheap: process.env.CLAUDE_CODE_MODEL_CHEAP || "haiku",
  claudeCodeModelDefault: process.env.CLAUDE_CODE_MODEL_DEFAULT || "sonnet",
  claudeCliPath: process.env.CLAUDE_CLI_PATH || null,
  claudeCodeTimeoutMs: optionalNumber("CLAUDE_CODE_TIMEOUT_MS") ?? 300_000,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  aiModelDefault: process.env.AI_MODEL_DEFAULT ?? "claude-sonnet-5",
  aiModelCheap: process.env.AI_MODEL_CHEAP ?? "claude-haiku-4-5-20251001",

  // Voyage AI (proveedor de embeddings, docs/DECISIONS.md — "Embeddings:
  // proveedor, modelo, chunking, top-k y regeneración"). Mismo criterio
  // que anthropicApiKey: vacío en vez de required() para no romper el
  // arranque de código que no necesita embeddings; quien sí los necesita
  // (VoyageEmbeddingProvider) falla explícito si está vacío.
  voyageApiKey: process.env.VOYAGE_API_KEY ?? "",

  // Sin default silencioso a propósito: si están vacíos, el código de
  // embeddings debe fallar explícitamente en vez de asumir un modelo
  // (plans/, decisión de rag-engineer). Fijado
  // en docs/DECISIONS.md: voyage-3-large @ 1024 dimensiones.
  embeddingModel: process.env.EMBEDDING_MODEL || null,
  embeddingDimensions: optionalNumber("EMBEDDING_DIMENSIONS"),

  // Perfil de dominio (plans/). Vacío =
  // perfil genérico incluido en el código.
  domainProfilePath: process.env.DOMAIN_PROFILE_PATH || null,

  // Directorio desde donde se lanzó el comando. `npm run -w` cambia el
  // cwd al del workspace; npm conserva el original en INIT_CWD.
  invocationCwd: process.env.INIT_CWD ?? process.cwd(),

  statusFilePath:
    process.env.CMA_STATUS_FILE_PATH ??
    path.join(REPO_ROOT, ".claude", "state", "status.json"),

  // Mapeo por defecto nombre_mostrado -> rol (docs/DATA_MODEL.md:
  // participants.role) para participantes reales nuevos al importar/
  // sincronizar (docs/DECISIONS.md, entrada 2026-08-04). Vacío = un
  // remitente nuevo sin mapping queda en UNKNOWN_PARTICIPANT_ROLE
  // ("desconocido"), nunca se infiere del nombre. --roles en
  // cli-import.ts puede sobreescribir puntualmente esta base.
  defaultParticipantRoles: process.env.PARTICIPANT_ROLE_MAP
    ? parseParticipantRoles(process.env.PARTICIPANT_ROLE_MAP)
    : {},
} as const;

export type AppConfig = typeof config;
