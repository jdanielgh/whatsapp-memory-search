# DOMAIN_MODEL.md

# Conversation Memory Assistant

## Propósito

Este documento define el dominio del sistema.

Describe las entidades del negocio, sus responsabilidades y las relaciones entre ellas, independientemente de cualquier tecnología utilizada (PostgreSQL, Prisma, Anthropic, etc.).

Este documento representa el lenguaje común (Ubiquitous Language) utilizado durante todo el desarrollo.

---

# Principios del dominio

## La conversación es la fuente de verdad

Toda la información del sistema proviene de una conversación de WhatsApp.

Ningún análisis puede existir sin una conversación.

---

## La evidencia nunca cambia

Los mensajes originales son evidencia.

Una vez almacenados nunca se modifican.

Nunca se eliminan.

Nunca se reescriben.

---

## El conocimiento puede evolucionar

Toda interpretación realizada por IA puede regenerarse.

El conocimiento derivado nunca modifica la evidencia original.

---

## Toda conclusión debe ser verificable

Cada análisis debe poder indicar qué mensajes utilizó para llegar a una conclusión.

---

# Entidades del dominio

---

## Conversation

### Descripción

Representa una conversación completa.

En la versión inicial existirá únicamente una conversación.

### Responsabilidades

- Agrupar todos los mensajes.
- Agrupar los participantes.
- Ser el contexto principal del sistema.

### Contiene

- Messages
- Participants
- Cases

---

## Participant

### Descripción

Persona que participa en la conversación.

### Responsabilidades

- Identificar al autor de cada mensaje.
- Representar un rol dentro de la conversación.

### Ejemplos

Organizador

Miembro

Sistema (futuro)

---

## Message

### Descripción

Representa un mensaje individual.

Es la unidad mínima de evidencia.

### Responsabilidades

- Conservar el texto original.
- Conservar fecha y hora.
- Conservar autor.
- Referenciar adjuntos.

### Restricciones

- Nunca puede modificarse.
- Nunca puede eliminarse.
- Nunca puede resumirse.

---

## Attachment

### Descripción

Archivo asociado a un mensaje.

### Tipos

- Imagen
- Audio
- Video
- Documento
- Sticker

---

## ImportJob

### Descripción

Representa un proceso de importación.

### Responsabilidades

- Registrar cuándo se importó información.
- Permitir reimportaciones.
- Mantener trazabilidad.

---

## Source

### Descripción

Origen de la información.

### Ejemplos

- WhatsApp Export
- WhatsApp Live (futuro)

---

# Modelo de conocimiento

---

## Case

### Descripción

Representa un tema continuo dentro de la conversación.

Un Case puede durar días, meses o años.

Agrupa múltiples eventos relacionados.

### Ejemplos

Planes de un viaje

Presupuesto compartido

Proyecto de trabajo

Salud

---

## Event

### Descripción

Representa un hecho ocurrido en un momento específico.

Puede involucrar uno o varios mensajes.

### Ejemplos

Propuesta

Aceptación

Negativa

Cambio de horario

Discusión

Acuerdo

Cancelación

Actividad

---

## Insight

### Descripción

Representa conocimiento confirmado.

Un Insight puede provenir de uno o varios eventos.

### Ejemplos

Existe un acuerdo para reunirse los sábados.

La propuesta fue rechazada.

Se acordó cambiar el horario.

---

## Entity

### Descripción

Elemento identificado dentro de un mensaje.

### Ejemplos

Persona

Lugar

Fecha

Hora

Institución

Actividad

Dinero

---

## Relationship

### Descripción

Relación entre entidades del dominio.

### Ejemplos

Persona → Participa en → Evento

Evento → Pertenece a → Case

Insight → Derivado de → Evento

---

# Artefactos Derivados

Los siguientes elementos no representan conceptos del negocio.

Son artefactos generados por procesos automáticos y pueden regenerarse en cualquier momento.

No poseen un ciclo de vida independiente.

No son Aggregate Roots.

Nunca modifican la evidencia ni el conocimiento del dominio.

---

## Analysis

### Descripción

Interpretación realizada por inteligencia artificial.

Nunca representa una verdad absoluta.

Siempre debe incluir un nivel de confianza.

### Ejemplos

Formalidad

Cordialidad

Tensión

Cooperación

Las dimensiones concretas las define el perfil de dominio activo (`analysisDimensions`).

---

## Observation

### Descripción

Conclusión preliminar obtenida por IA.

No constituye un hecho.

Puede convertirse posteriormente en un Insight.

### Ejemplo

"La conversación parece estar escalando."

---

## Embedding

### Descripción

Representación vectorial de un mensaje o conjunto de mensajes.

Su única finalidad es facilitar recuperación semántica.

No forma parte del conocimiento del negocio.

---

## Summary

### Descripción

Resumen generado automáticamente.

Puede existir por:

- Día
- Semana
- Mes
- Case
- Conversación

---

# Modelo del asistente

---

## Reminder

### Descripción

Actividad que deberá recordarse al usuario.

### Ejemplos

Reunión del jueves.

Entrega de un documento.

Pago pendiente.

---

## Draft

### Descripción

Mensaje sugerido por el sistema.

Nunca se envía automáticamente.

Siempre requiere aprobación del usuario.

---

## Suggestion

### Descripción

Recomendación realizada por el sistema.

### Ejemplos

Responder con un tono más formal.

Esperar antes de responder.

Adjuntar evidencia.

---

# Relaciones principales

Conversation

├── Participants

├── Messages

├── Cases

│

Case

├── Events

├── Insights

├── Summaries

│

Event

├── Messages

├── Analyses

├── Observations

│

Message

├── Attachments

├── Entities

├── Embedding

│

Analysis

├── Evidence (Messages)

├── Confidence

│

Reminder

├── Case

├── Event

---

# Reglas del dominio

## Evidencia

- Nunca se modifica.
- Nunca se elimina.

---

## Conocimiento

- Puede recalcularse.
- Puede regenerarse.

---

## IA

- Nunca inventa información.
- Siempre indica confianza.
- Siempre referencia evidencia.

---

## Asistente

- Nunca responde automáticamente.
- Nunca modifica mensajes.
- Nunca elimina historial.

---

# Objetivo del dominio

El objetivo del sistema no es almacenar mensajes.

El objetivo es transformar evidencia conversacional en conocimiento consultable, verificable y reutilizable, preservando siempre la integridad de la conversación original.