// Implementación Postgres/Drizzle de ImportJobRepository
// (src/archive/repositories/import-job-repository.ts).

import { eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/db/client.js";
import { db as defaultDb } from "../../infrastructure/db/client.js";
import { importJobs, sources } from "../../infrastructure/db/schema.js";
import type { SourceType } from "../domain/import-job.js";
import type { ImportJobRepository } from "../repositories/import-job-repository.js";

export class DrizzleImportJobRepository implements ImportJobRepository {
  constructor(private readonly db: Database = defaultDb) {}

  async getOrCreateSource(type: SourceType): Promise<{ id: string }> {
    const [existing] = await this.db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.type, type))
      .limit(1);
    if (existing) return existing;

    const [created] = await this.db
      .insert(sources)
      .values({ type })
      .returning({ id: sources.id });
    return created!;
  }

  async createImportJob(
    conversationId: string,
    sourceId: string
  ): Promise<{ id: string }> {
    const [created] = await this.db
      .insert(importJobs)
      .values({
        conversationId,
        sourceId,
        status: "RUNNING",
        startedAt: new Date(),
      })
      .returning({ id: importJobs.id });
    return created!;
  }

  async completeImportJob(
    importJobId: string,
    messagesImported: number
  ): Promise<void> {
    await this.db
      .update(importJobs)
      .set({ status: "SUCCESS", finishedAt: new Date(), messagesImported })
      .where(eq(importJobs.id, importJobId));
  }

  async failImportJob(importJobId: string, errorSummary: string): Promise<void> {
    await this.db
      .update(importJobs)
      .set({ status: "FAILED", finishedAt: new Date(), errorSummary })
      .where(eq(importJobs.id, importJobId));
  }
}
