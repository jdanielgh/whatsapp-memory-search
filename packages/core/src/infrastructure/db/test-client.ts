// Cliente Drizzle exclusivo de integration tests — siempre contra la
// base de datos de test efímera (src/infrastructure/db/test-db.ts),
// nunca la de desarrollo. Los repositorios lo reciben por constructor
// (mismo mecanismo de DI que usan con el `db` real).

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import { testDatabaseUrl } from "./test-db.js";

const pool = new Pool({ connectionString: testDatabaseUrl });

export const testDb = drizzle(pool, { schema });
export type TestDatabase = typeof testDb;
