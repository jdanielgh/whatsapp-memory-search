# PIPELINES.md

# WhatsApp Memory Search

## Propósito

Este documento define los pipelines de procesamiento del sistema.

Un pipeline representa una secuencia de pasos ejecutados para transformar evidencia en conocimiento.

Los pipelines son determinísticos, asíncronos e idempotentes.

---

# Principios

## PL-001

Toda evidencia se persiste antes de ser procesada.

---

## PL-002

Ningún pipeline modifica la evidencia.

---

## PL-003

Cada etapa debe poder reejecutarse de forma independiente.

---

## PL-004

Cada etapa debe ser idempotente.

Ejecutar el mismo pipeline múltiples veces produce el mismo resultado.

---

## PL-005

Cada etapa registra auditoría.

---

# Pipeline General

```text
Message
    │
    ▼
Persist Evidence
    │
    ▼
Metadata Extraction
    │
    ▼
Entity Detection
    │
    ▼
Event Detection
    │
    ▼
Case Resolution
    │
    ▼
Relationship Detection
    │
    ▼
Insight Generation
    │
    ▼
Summary Generation
    │
    ▼
Embedding Generation
    │
    ▼
Indexing
    │
    ▼
Ready
```

---

# Pipeline 1 - Importación

## Entrada

Archivo exportado de WhatsApp.

## Flujo

1. Validar archivo.
2. Crear ImportJob.
3. Crear Conversation si no existe.
4. Registrar Participants.
5. Registrar Messages.
6. Registrar Attachments.
7. Marcar evidencia como persistida.
8. Enviar mensajes al Pipeline General.

## Salida

Conversación completamente almacenada.

---

# Pipeline 2 - Sincronización

## Entrada

Nuevos mensajes.

## Flujo

1. Detectar mensajes nuevos.
2. Evitar duplicados.
3. Persistir evidencia.
4. Ejecutar Pipeline General.

---

# Pipeline 3 - Metadata Extraction

## Objetivo

Extraer información estructural del mensaje.

## Produce

* idioma
* longitud
* tipo
* emojis
* menciones
* respuesta a otro mensaje
* presencia de adjuntos

---

# Pipeline 4 - Entity Detection

## Objetivo

Detectar entidades mencionadas.

## Produce

* Personas
* Lugares
* Fechas
* Horarios
* Organizaciones
* Cantidades
* Teléfonos
* Correos

Cada entidad queda asociada al Message.

---

# Pipeline 5 - Event Detection

## Objetivo

Detectar eventos relevantes del dominio.

## Ejemplos

* propuesta
* aceptación
* rechazo
* acuerdo
* cancelación
* cambio
* recordatorio
* conflicto

Produce:

* Event
* Analysis
* Observation

---

# Pipeline 6 - Case Resolution

## Objetivo

Determinar si el Event pertenece a un Case existente.

## Flujo

1. Buscar Cases relacionados.
2. Calcular similitud.
3. Asociar Event.
4. Crear nuevo Case si corresponde.

Produce:

* Case existente actualizado

o

* Nuevo Case

---

# Pipeline 7 - Relationship Detection

## Objetivo

Construir relaciones entre entidades.

Ejemplos:

Persona

↓

Propone

↓

Reunión

Lugar

↓

Relacionado con

↓

Oficina

Produce:

Relationship.

---

# Pipeline 8 - Insight Generation

## Objetivo

Transformar múltiples eventos en conocimiento.

Ejemplos

* Cambios frecuentes de horario.
* Alta cooperación.
* Conflictos recurrentes.
* Tema recurrente.

Produce:

Insight.

---

# Pipeline 9 - Summary Generation

## Objetivo

Generar resúmenes.

Tipos

* Diario
* Semanal
* Mensual
* Por Case
* Conversación

Produce:

Summary.

---

# Pipeline 10 - Embedding Generation

## Objetivo

Generar representaciones vectoriales.

Objetos soportados

* Message
* Event
* Case
* Insight
* Summary

Produce:

Embedding.

---

# Pipeline 11 - Indexing

## Objetivo

Actualizar los índices de búsqueda.

Actualiza

* Full Text Search
* Vector Search
* Índices temporales
* Índices de entidades

Produce

Sistema listo para consultas.

---

# Pipeline 12 - Query Processing

## Entrada

Consulta del usuario.

## Flujo

```text
User Query
      │
      ▼
Intent Detection
      │
      ▼
Query Planning
      │
      ▼
Evidence Retrieval
      │
      ▼
Knowledge Retrieval
      │
      ▼
Context Assembly
      │
      ▼
LLM
      │
      ▼
Evidence Validation
      │
      ▼
Response
```

---

# Pipeline 13 - Reprocessing

## Objetivo

Actualizar artefactos derivados utilizando nuevos modelos.

Se ejecuta sobre:

* Analysis
* Observation
* Summary
* Insight
* Embedding

Nunca sobre:

* Message
* Participant
* Conversation
* Attachment

---

# Pipeline 14 - Reminder Processing

## Flujo

1. Crear Reminder.
2. Validar referencias.
3. Registrar estado.
4. Esperar ejecución futura.

---

# Pipeline 15 - Draft Generation

## Flujo

1. Recuperar contexto.
2. Recuperar evidencia.
3. Recuperar Insights.
4. Construir prompt.
5. Generar borrador.
6. Esperar aprobación del usuario.

Nunca enviar automáticamente.

---

# Estados del procesamiento

Esta progresión vive en `message_processing_state.status`
(`docs/DATA_MODEL.md`), no en `messages.status`: `messages` es evidencia
inmutable (SI-002) y solo llega hasta `PERSISTED` (fijado una única vez
al insertar). Cada etapa marca explícitamente su estado al terminar —
incluso si no produjo filas en la tabla de conocimiento correspondiente
(Entity/Event Detection pueden legítimamente no encontrar nada), para
que "sin resultados" sea distinguible de "todavía no procesado".

```text
NEW

↓

IMPORTED

↓

PERSISTED

↓

METADATA_READY

↓

ENTITY_READY

↓

EVENT_READY

↓

CASE_READY

↓

INSIGHT_READY

↓

SUMMARY_READY

↓

EMBEDDED

↓

INDEXED

↓

READY
```

---

# Recuperación ante fallos

Si una etapa falla:

* no se elimina evidencia
* no se reinicia el pipeline completo
* únicamente se reprocesa la etapa fallida

---

# Auditoría

Cada ejecución registra:

* pipeline
* etapa
* fecha
* duración
* versión
* modelo utilizado
* resultado
* errores

---

# Dependencias

```text
Import
    │
    ▼
Persist
    │
    ▼
Metadata
    │
    ▼
Entities
    │
    ▼
Events
    │
    ▼
Cases
    │
    ▼
Relationships
    │
    ▼
Insights
    │
    ▼
Summaries
    │
    ▼
Embeddings
    │
    ▼
Indexes
```

Una etapa nunca depende de una etapa posterior.

---

# Objetivo

Transformar evidencia inmutable en conocimiento estructurado mediante una secuencia de procesos independientes, auditables, reproducibles y regenerables, garantizando que el sistema pueda evolucionar sin comprometer la integridad de la conversación original.
