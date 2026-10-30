// globalSetup de vitest.integration.config.ts: crea/migra la base de
// datos de test efímera una sola vez antes de correr toda la suite.

import { setupTestDatabase } from "./test-db.js";

export default async function globalSetup(): Promise<void> {
  await setupTestDatabase();
}
