---
description: Importar/sincronizar el export de WhatsApp más reciente usando la skill whatsapp-ingest.
---

Sincroniza la conversación siguiendo la skill `whatsapp-ingest`
(Pipeline 1/2 de `docs/PIPELINES.md`).

1. Si es una tarea mecánica de correr el importador sobre un archivo ya
   dado, delega en el subagente `pipeline-ops` y trae solo el resumen del
   resultado (mensajes importados, duplicados descartados, errores).
2. Si requiere tocar el código del parser (no solo ejecutarlo), hazlo en
   la sesión principal siguiendo `whatsapp-ingest` y `rules/dev-style.md`
   (test obligatorio en el parser).
3. Nunca imprimas el contenido de los mensajes importados en la salida,
   solo el resumen numérico (`rules/security-privacy.md`).
4. Roles de participantes: `PARTICIPANT_ROLE_MAP` en `.env` es la base
   (docs/DECISIONS.md, entrada 2026-08-04); `--roles` de `cli-import.ts`
   la sobreescribe puntualmente si hace falta para una corrida. Un
   participante real nuevo sin mapping queda en `role='desconocido'` —
   nunca se infiere del nombre.

Argumento opcional: ruta del archivo de export. Si no se da, pregunta cuál
usar en vez de asumir uno.

$ARGUMENTS
