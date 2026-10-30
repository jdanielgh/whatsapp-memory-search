---
name: architecture-review
description: Chequeo periódico de salud del sistema (la app, no la config de Claude Code) — drift de esquema, embeddings huérfanos, errores de ingesta acumulados. Complementa a token-audit. Úsala cuando el usuario pida un chequeo de salud del sistema o auditar la base de datos/pipeline.
---

# architecture-review

Mira la aplicación (PostgreSQL + pipelines), no `.claude/`. Para eso está
`token-audit`.

## Checklist

1. **Drift de esquema**: comparar el esquema real de PostgreSQL contra
   `docs/DATA_MODEL.md`. Si hay una diferencia, decidir si el código quedó
   desactualizado o si `docs/DATA_MODEL.md` necesita actualizarse — nunca dejar
   que diverjan en silencio.
2. **Embeddings huérfanos**: filas en `embeddings` cuyo
   (`subject_type`, `subject_id`) ya no existe en la tabla origen (por
   ejemplo un `Case` fusionado con otro). No afectan evidencia (SI-029)
   pero degradan Semantic Search con ruido — candidatas a limpieza.
3. **`import_jobs` en estado `FAILED`/`MANUAL_REVIEW`** acumulados:
   cuántos, desde cuándo, si siguen sin resolverse.
4. **Mensajes atascados** antes de `READY` en el pipeline (ver estados en
   `docs/PIPELINES.md`): indica una etapa que falla sistemáticamente, no un
   caso aislado.
5. **Spot-check de invariantes** (`docs/SYSTEM_INVARIANTS.md`): confirmar por
   muestreo que `messages.content_hash` no cambió para una muestra de
   filas — evidencia de que nada ha tocado la evidencia por error.
6. **Cobertura de `Case`**: eventos sin `case_id` resuelto acumulándose
   (Pipeline 6 fallando silenciosamente en su clasificación).

## Salida esperada

Reporte breve con hallazgos y severidad (`docs/ERROR_HANDLING.md`: LOW / MEDIUM
/ HIGH / CRITICAL), no una corrección automática — decisiones sobre datos
reales del usuario no se toman sin su confirmación.
