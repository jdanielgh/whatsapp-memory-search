// Cliente Drizzle de runtime. Usa DATABASE_URL (rol restringido cma_app,
// ver migrate.ts) — nunca MIGRATIONS_DATABASE_URL. Cualquier código de
// aplicación que necesite la base de datos importa `db` desde aquí, no
// crea su propio Pool.

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../../shared/config.js";
import * as schema from "./schema.js";

const pool = new Pool({ connectionString: config.databaseUrl });

export const db = drizzle(pool, { schema });
export type Database = typeof db;
