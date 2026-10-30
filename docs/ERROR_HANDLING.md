# ERROR_HANDLING.md

# WhatsApp Memory Search

## Propósito

Este documento define la estrategia de manejo de errores del sistema.

Su objetivo es garantizar que los fallos nunca comprometan la evidencia, que los procesos puedan recuperarse de forma segura y que todas las operaciones sean auditables.

---

# Principios

## EH-001

La pérdida de evidencia es inaceptable.

---

## EH-002

Todo error debe registrarse.

---

## EH-003

Los errores deben ser recuperables siempre que sea posible.

---

## EH-004

Un fallo en un pipeline nunca debe afectar otros pipelines.

---

## EH-005

Toda operación debe ser idempotente.

---

## EH-006

La recuperación automática tiene prioridad sobre la intervención manual.

---

# Clasificación de errores

## Error de Validación

Ocurre cuando la entrada no cumple las reglas esperadas.

Ejemplos

* Archivo inválido.
* Mensaje corrupto.
* Fecha inválida.
* Formato desconocido.

### Acción

* Rechazar operación.
* Registrar auditoría.
* Conservar evidencia disponible.

---

## Error de Persistencia

Ocurre al almacenar información.

Ejemplos

* Base de datos no disponible.
* Violación de restricciones.
* Timeout.

### Acción

* Reintentar.
* Registrar error.
* No continuar el pipeline.

---

## Error de Procesamiento

Ocurre durante un pipeline.

Ejemplos

* Entity Detection.
* Event Detection.
* Summary Generation.

### Acción

* Detener únicamente la etapa afectada.
* Registrar estado.
* Permitir reejecución.

---

## Error del Modelo de IA

Ejemplos

* Timeout.
* Rate limit.
* Respuesta inválida.
* Salida incompleta.

### Acción

* Reintentar.
* Registrar modelo utilizado.
* Conservar versiones anteriores.

---

## Error de Búsqueda

Ejemplos

* Índice corrupto.
* Embedding inexistente.
* Error de ranking.

### Acción

* Regenerar índices cuando sea posible.
* No modificar evidencia.

---

## Error Interno

Errores inesperados.

Ejemplos

* Excepciones no controladas.
* Configuración inválida.
* Dependencias no disponibles.

### Acción

* Registrar información suficiente para diagnóstico.
* Marcar la operación como fallida.
* Permitir recuperación.

---

# Estrategia de Recuperación

## Recuperación por etapa

Cada etapa del pipeline puede ejecutarse nuevamente de forma independiente.

Nunca es necesario reiniciar el procesamiento completo.

---

## Recuperación por artefacto

Los siguientes artefactos pueden eliminarse y regenerarse:

* Analysis
* Observation
* Insight
* Summary
* Embedding

Nunca:

* Conversation
* Participant
* Message
* Attachment

---

## Recuperación por lote

Si una importación falla parcialmente:

* conservar evidencia persistida
* registrar progreso
* continuar desde el último punto consistente

---

# Reintentos

## Operaciones elegibles

* Persistencia
* IA
* Indexación
* Servicios externos

---

## Operaciones no elegibles

* Validación
* Integridad del dominio
* Violaciones de reglas de negocio

---

## Política

Cada operación define:

* número máximo de intentos
* estrategia de espera
* condición de abandono

---

# Idempotencia

Todas las operaciones críticas deben poder ejecutarse múltiples veces sin producir resultados inconsistentes.

Ejemplos

* importar mensajes
* generar embeddings
* detectar entidades
* detectar eventos
* actualizar índices

---

# Estados de Error

```text
PENDING

↓

RUNNING

↓

SUCCESS
```

o

```text
PENDING

↓

RUNNING

↓

FAILED

↓

RETRYING

↓

SUCCESS
```

o

```text
PENDING

↓

RUNNING

↓

FAILED

↓

MANUAL_REVIEW
```

---

# Información registrada

Todo error debe registrar como mínimo:

* identificador
* fecha
* pipeline
* etapa
* tipo
* severidad
* mensaje
* excepción
* contexto
* operación
* duración
* versión del sistema
* versión del modelo (si aplica)

---

# Severidad

## LOW

El sistema puede continuar sin impacto funcional.

Ejemplo

Fallo temporal de generación de resumen.

---

## MEDIUM

Se afecta una funcionalidad, pero existe recuperación automática.

Ejemplo

Fallo en generación de embeddings.

---

## HIGH

Se interrumpe un pipeline importante.

Ejemplo

Persistencia indisponible.

---

## CRITICAL

Compromete la disponibilidad o la integridad del sistema.

Ejemplo

Corrupción de la base de datos.

---

# Reprocesamiento

Los errores relacionados con IA nunca requieren modificar la evidencia.

La recuperación consiste en regenerar:

* Analysis
* Observation
* Insight
* Summary
* Embedding

---

# Auditoría

Toda recuperación debe registrar:

* motivo
* usuario o proceso
* fecha
* artefactos afectados
* resultado

---

# Notificación

El sistema podrá notificar errores cuando:

* una importación falle
* un reprocesamiento falle repetidamente
* exista intervención manual requerida

Los errores internos recuperables no requieren notificación al usuario.

---

# Restricciones

Nunca eliminar evidencia para resolver un error.

Nunca sobrescribir análisis históricos.

Nunca ocultar errores.

Nunca continuar un pipeline cuando una precondición obligatoria no se cumple.

Nunca responder al usuario utilizando artefactos marcados como inválidos o incompletos.

---

# Objetivo

Garantizar que todos los fallos sean detectables, auditables y recuperables, preservando siempre la evidencia original y asegurando que el conocimiento derivado pueda regenerarse sin comprometer la integridad del sistema.
