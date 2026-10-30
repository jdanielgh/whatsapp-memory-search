// Integration test obligatorio (rules/dev-style.md, regla 4): un
// ImportJob mal cerrado (status/errorSummary incorrectos) deja
// trazabilidad falsa sobre qué se importó — mismo criterio de "fallo
// silencioso" que whatsapp-ingest. Contra la base de datos de test
// efímera (src/infrastructure/db/test-db.ts).

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { testDb } from "../../infrastructure/db/test-client.js";
import { importJobs } from "../../infrastructure/db/schema.js";
import { resetTestDatabase } from "../../infrastructure/db/test-db.js";
import { DrizzleConversationRepository } from "./conversation-repository.drizzle.js";
import { DrizzleImportJobRepository } from "./import-job-repository.drizzle.js";

describe("DrizzleImportJobRepository (integration)", () => {
  const conversationRepo = new DrizzleConversationRepository(testDb);
  const importJobRepo = new DrizzleImportJobRepository(testDb);

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("getOrCreateSource dedupea por tipo", async () => {
    const first = await importJobRepo.getOrCreateSource("whatsapp_export");
    const second = await importJobRepo.getOrCreateSource("whatsapp_export");

    expect(second.id).toBe(first.id);
  });

  it("createImportJob arranca en RUNNING y completeImportJob lo cierra en SUCCESS", async () => {
    const conversation = await conversationRepo.getOrCreateConversation(null);
    const source = await importJobRepo.getOrCreateSource("whatsapp_export");
    const job = await importJobRepo.createImportJob(conversation.id, source.id);

    const [runningRow] = await testDb
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job.id));
    expect(runningRow?.status).toBe("RUNNING");
    expect(runningRow?.finishedAt).toBeNull();

    await importJobRepo.completeImportJob(job.id, 42);

    const [doneRow] = await testDb
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job.id));
    expect(doneRow?.status).toBe("SUCCESS");
    expect(doneRow?.messagesImported).toBe(42);
    expect(doneRow?.finishedAt).not.toBeNull();
  });

  it("failImportJob deja el job en FAILED con el resumen de error", async () => {
    const conversation = await conversationRepo.getOrCreateConversation(null);
    const source = await importJobRepo.getOrCreateSource("whatsapp_export");
    const job = await importJobRepo.createImportJob(conversation.id, source.id);

    await importJobRepo.failImportJob(job.id, "fallo de prueba inventado");

    const [row] = await testDb
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job.id));
    expect(row?.status).toBe("FAILED");
    expect(row?.errorSummary).toBe("fallo de prueba inventado");
  });
});
