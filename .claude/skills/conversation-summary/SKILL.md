---
name: conversation-summary
description: Genera y guarda resúmenes precalculados (diario/semanal/mensual/por Case/conversación completa). Úsala cuando se implemente o depure la generación de resúmenes, nunca para resumir mensajes al vuelo dentro de una respuesta.
---

# conversation-summary

Implementa el Pipeline 9 (Summary Generation) de `docs/PIPELINES.md` y la tabla
`summaries` de `docs/DATA_MODEL.md`.

## Regla central

Los resúmenes se **precalculan y se guardan**, nunca se regeneran en cada
consulta del usuario. Es uno de los mayores ahorros de tokens a nivel de
runtime del agente. Si una skill o endpoint
necesita un resumen, primero consulta `summaries` (Q-CS-01); solo si no
existe uno vigente se dispara la generación.

## Cuándo se genera

- Diario / semanal / mensual: job programado (batch), no on-demand.
- Por Case: al cerrar el Case, o al superar un umbral de eventos nuevos
  desde el último resumen.
- Conversación completa: bajo demanda explícita del usuario (UC-010), es
  costoso y no debe recalcularse automáticamente.

## Reglas duras

- Cada fila de `summaries` registra `model`, `prompt_version` y
  `generated_at` (SI-019/020/021) — nunca se sobrescribe una fila
  existente, se inserta una nueva y se decide cuál es la vigente.
- El resumen nunca sustituye a la evidencia: cualquier afirmación del
  resumen debe poder trazarse a mensajes/eventos concretos si el usuario
  lo pide (Q-EV-*).
- Nunca generar un resumen de una conversación completa como parte de una
  respuesta interactiva simple ("¿qué pasó hoy?") sin verificar primero si
  ya existe uno reciente y vigente.
