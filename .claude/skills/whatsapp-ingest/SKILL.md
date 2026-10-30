---
name: whatsapp-ingest
description: Normaliza un export crudo de WhatsApp (.txt/.json) al esquema canónico de docs/DATA_MODEL.md. Úsala cuando el usuario pida importar, parsear, ingerir o sincronizar un export de WhatsApp, o cuando toques el parser/importador.
---

# whatsapp-ingest

Implementa el Pipeline 1 (Importación) y Pipeline 2 (Sincronización) de
`docs/PIPELINES.md`. Es la skill que más se invoca: casi todo el trabajo
temprano del proyecto pasa por aquí.

## Flujo (Pipeline 1)

1. Validar el archivo (formato reconocido, no corrupto). Si falla: error
   de validación, no se persiste nada (`docs/ERROR_HANDLING.md`, "Error de
   Validación").
2. Crear `import_jobs` (estado `RUNNING`, `source_id` apuntando a
   `sources.type = 'whatsapp_export'`).
3. Crear `conversations` si no existe (la v1 solo maneja una).
4. Registrar `participants` (dedup por nombre mostrado en el export).
   El rol (etiqueta libre, ej. `organizador` | `miembro` | `sistema`) sale de `PARTICIPANT_ROLE_MAP`
   en `.env` (base) y opcionalmente `--roles` en `cli-import.ts`
   (override puntual); nunca se infiere del nombre. Sin mapping para un
   remitente real nuevo, queda en `role='desconocido'`
   (`UNKNOWN_PARTICIPANT_ROLE`, `docs/DECISIONS.md` 2026-08-04) — es un
   estado válido, no un error, hasta que se defina un flujo con
   pregunta al usuario (pensado para cuando exista UI).
5. Registrar `messages`: dedup por `content_hash` (hash de
   `sent_at + participant_id + content`), timestamps normalizados a
   UTC+TZ explícita, `raw_source` conservando la línea original completa.
6. Registrar `attachments` referenciados en el texto (WhatsApp exporta
   adjuntos como placeholder `<attached: nombre-archivo.ext>` o
   equivalente según idioma/versión de la app — verificar el patrón real
   contra una muestra antes de asumirlo fijo).
7. Marcar el `import_job` como `SUCCESS` y disparar el Pipeline General
   (metadata → entidades → eventos → cases → insights → resúmenes →
   embeddings → índices) de forma asíncrona, sin bloquear la persistencia.

## Reglas duras

- Nunca modificar una fila existente de `messages` para "corregir" un
  parseo previo: si se detecta un error de parseo, se corrige el
  parser y se re-ingiere como mensajes nuevos con dedup por
  `content_hash`, o se documenta el caso — nunca se hace `UPDATE` sobre
  evidencia ya persistida (SI-002).
- Idempotencia obligatoria (PL-004, SI-031): ejecutar la ingesta dos veces
  sobre el mismo archivo no debe duplicar mensajes.
- Si la importación falla a mitad de archivo: conservar lo ya persistido,
  registrar el progreso, permitir continuar desde el último punto
  consistente (`docs/ERROR_HANDLING.md`, "Recuperación por lote").
- Este es uno de los dos puntos del proyecto con test obligatorio
  (`rules/dev-style.md`). Cubrir al menos: dedup correcto, timestamps con
  zona horaria ambigua, mensajes multilínea, adjuntos sin archivo real
  presente.

## Formato de export de WhatsApp — cosas que suelen romper el parser

- El formato de fecha/hora cambia según idioma y configuración regional
  del teléfono que exportó (12h vs 24h, `dd/mm/yy` vs `mm/dd/yy`).
- Los mensajes multilínea no repiten el prefijo `[fecha, hora] Nombre:`.
- Mensajes de sistema ("Los mensajes están cifrados de extremo a extremo",
  cambios de número, etc.) no tienen `participant_id` real — decidir si se
  descartan o se asignan a un `Participant` "Sistema" (ver
  `docs/DOMAIN_MODEL.md`, Participant → "Sistema (futuro)").

## Tareas relacionadas, no de esta skill

Clasificación, detección de entidades/eventos y generación de embeddings
son etapas posteriores del Pipeline General — no se implementan aquí, solo
se disparan.
