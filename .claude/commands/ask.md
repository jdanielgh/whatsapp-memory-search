---
description: Responder una pregunta en lenguaje natural sobre la conversación, siempre con evidencia.
argument-hint: <pregunta>
---

Responde la siguiente pregunta sobre la conversación usando
exclusivamente el Search Layer (skill `rag-retrieval` / consultas de
`docs/QUERY_CATALOG.md`), siguiendo el Pipeline 12 (Query Processing) de
`docs/PIPELINES.md`.

Reglas:

- Nunca cargues ni pegues historial crudo en el contexto para responder;
  la recuperación pasa por script/consulta catalogada.
- Si no hay evidencia suficiente, dilo explícitamente — no completes con
  suposiciones (`docs/VISION.md`, "La IA interpreta, no inventa").
- La respuesta debe indicar qué mensajes/eventos la respaldan (SI-037).

Pregunta: $ARGUMENTS
