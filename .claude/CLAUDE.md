# Proyecto: WhatsApp Memory Search

Agente personal que archiva, indexa (RAG) y eventualmente responde una
conversación de WhatsApp. Stack: Node.js/TypeScript + PostgreSQL + pgvector.
La IA (Anthropic) se consume mediante una abstracción; el dominio nunca
depende de su SDK directamente.

## Reglas globales

1. El historial de mensajes vive en PostgreSQL, nunca en el contexto del
   chat ni en archivos de `.claude/`. Toda recuperación de mensajes pasados
   pasa por la skill `rag-retrieval` o por una consulta de `docs/QUERY_CATALOG.md`,
   nunca por copiar texto al chat.
2. Nunca imprimir el contenido completo de una conversación salvo pedido
   explícito. Un historial puede contener datos personales de terceros
   reales, menores incluidos.
3. La evidencia (`Conversation`, `Participant`, `Message`, `Attachment`) es
   inmutable: nunca se genera código que actualice o borre esas tablas.
   Ver `docs/SYSTEM_INVARIANTS.md`.
4. No hardcodear claves/tokens; todo en variables de entorno (`.env`, fuera
   de git).
5. Respuestas de desarrollo: directas, sin relleno. Código y explicación
   mínima necesaria salvo que se pida detalle.
6. Antes de tocar el esquema de datos o el pipeline de embeddings, usar el
   subagente `rag-engineer`, no iterar directo en la sesión principal.
7. Tareas mecánicas y ruidosas (ingesta, backups, verificación de
   integridad) se delegan al subagente `pipeline-ops`, no a la sesión
   principal.

Detalle de cada tema vive en `rules/` y `skills/`, no aquí. El contexto de
producto (dominio, casos de uso, invariantes) vive en `docs/`. Para
entender el flujo completo de un vistazo, empezar por
`docs/VISUAL_GUIDE.md` (diagramas de arquitectura, pipelines, estados y
validación de evidencia). El resto:
`docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/DOMAIN_MODEL.md`,
`docs/AGGREGATES.md`, `docs/DATA_MODEL.md`, `docs/BOUNDED_CONTEXTS.md`,
`docs/UBIQUITOUS_LANGUAGE.md`, `docs/SYSTEM_INVARIANTS.md`,
`docs/PIPELINES.md`, `docs/QUERY_CATALOG.md`, `docs/USE_CASES.md`,
`docs/SECURITY.md`, `docs/ERROR_HANDLING.md`, `docs/AI_PROVIDERS.md` (motores
de IA: cuál usar, qué consume y cómo agregar otro).
