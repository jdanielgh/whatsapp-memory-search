# BOUNDED_CONTEXTS.md

# Conversation Memory Assistant

## Propósito

Este documento existía vacío. Lo completo a partir del stub que ya vivía al final de `UBIQUITOUS_LANGUAGE.md` ("Bounded Contexts") y de la lista de módulos de `src/` en `ARCHITECTURE.md`, dejando explícito qué hay dentro y fuera del contexto actual.

Un Bounded Context delimita dónde un modelo y un lenguaje ubicuo son válidos. Fuera de ese límite, los mismos términos pueden significar otra cosa.

---

## Contexto actual: Conversation Intelligence

Hoy existe un único Bounded Context. Todo el sistema descrito en `DOMAIN_MODEL.md`, `AGGREGATES.md` y `UBIQUITOUS_LANGUAGE.md` vive dentro de él.

### Qué incluye

Los módulos de `packages/core/src/` (`archive`, `conversation`, `processing`, `knowledge`, `analysis`, `search`, `assistant`, `api`) son subdivisiones internas de este único contexto, no contextos separados. Comparten el mismo modelo de dominio y el mismo lenguaje ubicuo.

Aggregates que viven dentro: `Conversation`, `Case`, `Reminder`, `ImportJob` (ver `AGGREGATES.md`).

### Qué queda fuera (sistemas externos, no parte del contexto)

* **WhatsApp** — fuente de evidencia. Se integra vía `Source` / `ImportJob`, nunca se modela como parte del dominio.
* **Anthropic (proveedor de IA)** — se consume a través de la abstracción de IA descrita en `ARCHITECTURE.md` ("IA desacoplada"). El dominio nunca depende de su SDK directamente.
* **PostgreSQL + pgvector** — infraestructura de persistencia. Detalle en `DATA_MODEL.md`.

Estos tres son *upstream/downstream* del contexto pero no comparten su modelo: una integración desacoplada, no lenguaje compartido.

---

## Contextos futuros (aún no existen — solo se anticipan)

`UBIQUITOUS_LANGUAGE.md` ya menciona estos nombres. Se documentan aquí las condiciones bajo las que valdría la pena separarlos, para no crearlos prematuramente:

| Contexto futuro | Cuándo separarlo | Relación con Conversation Intelligence |
|---|---|---|
| **Messaging** | Cuando el sistema empiece a *enviar* mensajes de WhatsApp en vivo (webhook bidireccional), no solo a leerlos. | Consumer del `Draft` generado por Conversation Intelligence. Conversation Intelligence nunca debe depender de Messaging. |
| **Calendar** | Cuando se gestionen eventos de calendario reales (no solo `Event` como hecho narrativo) vinculados al usuario. | Consumer de `Reminder` y `Case`. Relación tipo *customer/supplier*: Calendar pide datos, Conversation Intelligence no sabe que Calendar existe. |
| **Reminders** | Si `Reminder` crece lo suficiente (canales de notificación, recurrencia, snooze) como para dejar de ser un Aggregate simple dentro de Conversation Intelligence. | Hoy `Reminder` vive dentro del contexto actual. Separar solo si la complejidad de notificación empieza a ensuciar el dominio conversacional. |
| **Contacts** | Si en el futuro se analiza más de una conversación / más de dos participantes de forma estructurada. | Compartiría `Participant` mediante *shared kernel* mínimo (solo el identificador), no el resto del modelo. |
| **Notifications** | Cuando existan múltiples canales de salida (push, email, WhatsApp) para `Reminder`/`Draft`. | Downstream puro; solo consume, nunca escribe en Conversation Intelligence. |

**Regla de decisión:** no crear ninguno de estos contextos hasta que el dolor de mantenerlo todo junto sea mayor que el costo de la separación. Para un proyecto de un solo desarrollador y una sola conversación, es fácil sobre-diseñar límites que nunca se necesitan.

---

## Mapa de contexto (hoy)

```text
        WhatsApp (externo)
              │
              ▼
   ┌─────────────────────────┐
   │  Conversation Intelligence │  ← único Bounded Context
   │  (archive, processing,   │
   │   knowledge, analysis,   │
   │   search, assistant, api)│
   └─────────────────────────┘
              │
              ▼
   PostgreSQL + pgvector (infra, externo al dominio)
              │
   Anthropic (infra, externo al dominio, vía abstracción de IA)
```

Sin integraciones entre contextos todavía porque solo existe uno.

---

## Objetivo

Dejar explícito que la ausencia de múltiples Bounded Contexts hoy es una decisión deliberada, no un olvido, y fijar el criterio para separar uno cuando corresponda.
