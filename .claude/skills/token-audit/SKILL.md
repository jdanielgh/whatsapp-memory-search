---
name: token-audit
description: Auditoría periódica de la propia configuración de Claude Code (no de la app). Revisa tamaño de CLAUDE.md + rules, número de skills/agents activos, y MCPs habilitados. Úsala cuando el usuario pida revisar/auditar/podar la configuración de .claude, o periódicamente por mantenimiento.
---

# token-audit

Mantenimiento manual, no automático (no es un hook — invocarlo gasta
tokens deliberadamente cuando se decide hacerlo, no en cada sesión).

## Checklist

1. **`CLAUDE.md` + `rules/*.md` combinados**: contar líneas totales.
   Objetivo: mantenerse por debajo de ~100 líneas combinadas. Si se supera,
   identificar qué puede moverse a una skill (carga bajo demanda) en vez
   de vivir en algo que se carga siempre.
2. **Número de skills**: cada una añade una línea de descripción al
   catálogo que Claude evalúa en cada sesión. Si dos skills se solapan en
   cuándo se activan, fusionarlas.
3. **Número de subagentes**: mismo criterio. Hoy son 2 (`pipeline-ops`,
   `rag-engineer`) — no añadir un tercero salvo que haya una clase de
   tarea claramente distinta que hoy no tenga dueño.
4. **MCPs activos**: verificar contra la configuración real (no contra lo
   que se recuerda haber activado). Objetivo: 1–2 como máximo. Cada MCP
   adicional reduce la ventana de contexto útil disponible.
5. **Comandos** (`commands/*.md`): confirmar que cada uno sigue apuntando
   a una skill/tarea real y no quedó huérfano tras un refactor.

## Salida esperada

Un resumen corto: qué está dentro de presupuesto, qué se pasó, y una
recomendación concreta de qué podar — no una reescritura automática. El
usuario decide si aplica la poda.
