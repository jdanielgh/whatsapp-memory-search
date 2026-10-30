# analysis

AI Analysis Layer. Produce `Analysis`, `Observation`, `Embedding`,
`Summary` — artefactos derivados SIN Aggregate Root ni repositorio propio
(docs/AGGREGATES.md, "Artefactos Derivados"). Referencia polimórfica
(`subject_type`/`subject_id`) al Aggregate que interpretan.

Nunca modifica mensajes. Nunca elimina información (docs/ARCHITECTURE.md).

Embeddings: `embeddings.ts` (Pipeline 10, Message únicamente por ahora) +
`domain/embedding-chunking.ts` + `repositories/embeddings-repository.ts` +
`infrastructure/embeddings-repository.drizzle.ts` +
`infrastructure/cli-embed.ts` (`npm run process:embeddings`). Decisión de
proveedor/modelo/chunking/top-k/regeneración: `docs/DECISIONS.md`,
"Embeddings: proveedor, modelo, chunking, top-k y regeneración". Búsqueda
por similitud vive en `src/search/queries/semantic-search.ts` (Q-SEM-01),
no acá — este layer solo genera y persiste el vector. Summaries: ver
`plans/`.
