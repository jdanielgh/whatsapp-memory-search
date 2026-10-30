---
name: rag-retrieval
description: Encapsula la estrategia de recuperación semántica (chunking, modelo de embeddings, top-k). Úsala cuando se toque código de búsqueda/recuperación, se generen embeddings, o se responda una pregunta en lenguaje natural sobre la conversación.
---

# rag-retrieval

Centraliza cómo se recupera contexto para que no se reexplique la
estrategia cada vez que se toca el código de búsqueda. Implementa
Q-SEM-01/Q-SEM-02 de `docs/QUERY_CATALOG.md` y la etapa de Embedding Generation
(Pipeline 10) de `docs/PIPELINES.md`.

## Decisiones ya fijadas por `rag-engineer`

Ver `docs/DECISIONS.md`, "Embeddings: proveedor, modelo, chunking, top-k
y regeneración" para la justificación completa de cada una.

- **Proveedor**: Voyage AI (`packages/core/src/infrastructure/ai/voyage-embedding-provider.ts`),
  única implementación de embeddings — Anthropic no expone ese endpoint.
- **Modelo/dimensión**: `voyage-3-large` @ 1024 dimensiones (columna
  `embeddings.vector VECTOR(1024)` en `docs/DATA_MODEL.md`).
- **Estándar, no contextualizado**: se usa `voyage-3-large` con
  `input_type` document/query, no `voyage-context-3`. En su lugar, el
  chunking (siguiente punto) resuelve la ambigüedad de mensajes cortos
  sin depender de un modelo que necesita "documentos" completos sobre una
  conversación que crece sin límite.
- **Chunking**: `packages/core/src/analysis/domain/embedding-chunking.ts`. Un chunk =
  el mensaje ancla + hasta 2 mensajes previos del mismo hilo (evidencia
  inmutable, así que el chunk de un mensaje es determinista para
  siempre), con remitentes etiquetados neutralmente ("Participante 1"),
  mismo criterio que Event Detection.
- **`top-k`**: `DEFAULT_SEMANTIC_TOP_K = 3` en
  `packages/core/src/search/queries/semantic-search.ts` (Q-SEM-01) — bajado de 5 a 3
  cuando cada resultado pasó a traer la ventana completa en vez de un
  mensaje suelto (ver "Ventana embebida..." abajo): con dedup cada
  resultado ya es distinto, pero también ~3x más caro en tokens, así que
  3 mantiene el presupuesto de contexto en el mismo orden de magnitud que
  antes. Extremo bajo del rango 3-5. Q-SEM-02 (Cases) queda deferred
  hasta que exista generación de embeddings de `Case`.
- **Ventana embebida viaja con el resultado, y se deduplica por
  solapamiento** (`docs/DECISIONS.md`, "Cierre del pendiente: la ventana
  viaja con el resultado + deduplicación por solapamiento"). El vector
  representa la ventana (ancla + hasta `CONTEXT_WINDOW_SIZE` mensajes
  previos), no el ancla aislado — `SemanticSearchResult` refleja eso:
  - `content`: solo el mensaje ancla (compatibilidad).
  - `contextMessageIds` / `windowContent`: la ventana completa que
    efectivamente se comparó contra la consulta — usar esto, no `content`
    a solas, para justificar por qué un resultado matcheó (un mensaje
    corto como "listo" con score alto solo se explica con su contexto).
  - Antes de aplicar `top-k`, los candidatos cuya ventana comparte al
    menos un `messageId` con la de un resultado ya elegido se descartan
    (mismo intercambio, no aporta presupuesto nuevo) — el de mayor score
    del grupo queda como representante. `findPrecedingMessages`
    (`packages/core/src/infrastructure/db/preceding-messages.ts`) es la fuente única de
    "mensajes previos del hilo", compartida con Embedding Generation para
    que las dos ventanas nunca puedan divergir.
  - Un umbral de score se evaluó y se descartó dos veces (no arregla
    redundancia ni contexto mutilado — el modelo ya discrimina bien,
    medido contra la distribución completa del corpus).
- **Regeneración (SI-028)**: nunca `UPDATE`, siempre fila nueva. La
  versión vigente se decide por lo que apunte `EMBEDDING_MODEL`/
  `EMBEDDING_DIMENSIONS` en `.env` (Semantic Search filtra por
  `model`/`dims`), no por una columna `superseded_by`. Cambiar de
  dimensión sí es una migración (trunca `embeddings`, nunca `messages`).

Nuevos cambios a estos valores pasan por `rag-engineer`
(`rules/agents-and-context.md`), no se fijan arbitrariamente en código de
aplicación.

## Reglas duras

- SI-036: la búsqueda semántica nunca sustituye a la exacta. Si la
  consulta del usuario es literal (fecha, texto exacto, participante),
  usar Exact Search (`docs/QUERY_CATALOG.md`, Q-EX-*) aunque Semantic Search
  también pudiera responder.
- SI-037: toda respuesta debe poder reconstruirse desde la evidencia — el
  resultado de una búsqueda semántica siempre incluye el `message_id`
  origen, nunca solo el texto generado.
- Los embeddings son regenerables (SI-028): si cambia el modelo, no se
  edita la fila existente, se genera una nueva y se decide si se
  reemplaza o se versiona (ver `analyses.superseded_by` en
  `docs/DATA_MODEL.md` como patrón de referencia).

## Al depurar una consulta que devuelve contexto irrelevante

1. Verificar primero si el intent debería haber usado Exact Search en vez
   de Semantic Search.
2. Revisar el `top-k` antes de sospechar del modelo de embeddings.
3. Si el problema persiste, es tarea de `rag-engineer`, no de iteración
   rápida en la sesión principal.
