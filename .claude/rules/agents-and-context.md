# agents-and-context

Modelo: Haiku para mecánico/repetitivo (`pipeline-ops`), Sonnet para
desarrollo normal, Opus solo para decisiones de arquitectura puntuales
(escalar manualmente dentro de `rag-engineer` si hace falta).

No negociable: el historial de WhatsApp jamás se pega ni se carga completo
en el contexto de Claude Code, ni siquiera para depurar. Toda recuperación
pasa por la skill `rag-retrieval` o por `docs/QUERY_CATALOG.md`. Para fixtures
de debug, usa datos inventados, nunca un extracto real.
