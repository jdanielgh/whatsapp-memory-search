# processing

Processing Layer. Pipelines 3-7 de docs/PIPELINES.md: Metadata Extraction,
Entity Detection, Event Detection, Case Resolution, Relationship
Detection. Ver `plans/`.

Cada etapa es independiente y reejecutable (PL-003). El fallo de una
etapa nunca bloquea la persistencia de mensajes (SI-034).
