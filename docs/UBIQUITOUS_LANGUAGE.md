# UBIQUITOUS_LANGUAGE.md

# WhatsApp Memory Search

## Propósito

Este documento define el lenguaje ubicuo (Ubiquitous Language) utilizado en todo el proyecto.

Todos los miembros del proyecto —personas, documentación, código e inteligencia artificial— deben utilizar estos términos con el mismo significado.

El objetivo es evitar ambigüedades y mantener un vocabulario consistente durante el desarrollo.

---

# Principios

- Cada concepto tiene un único nombre.
- Un mismo término nunca representa dos conceptos diferentes.
- Los nombres del dominio son independientes de la tecnología.
- El código debe utilizar esta terminología siempre que sea posible.

---

# Glosario

## Conversation

Representa una conversación completa entre participantes.

Es el contexto principal del sistema.

Una conversación contiene mensajes, participantes y conocimiento derivado.

---

## Participant

Persona que participa en una conversación.

Ejemplos:

- Organizador
- Miembro

Cada mensaje pertenece exactamente a un participante.

---

## Message

Unidad mínima de evidencia.

Representa un mensaje individual enviado dentro de una conversación.

Un mensaje nunca se modifica ni se elimina.

---

## Attachment

Archivo asociado a un mensaje.

Ejemplos:

- Imagen
- Audio
- Video
- Documento
- Sticker

---

## Evidence

Información original proveniente de la conversación.

La evidencia constituye la fuente de verdad del sistema.

Incluye:

- mensajes
- adjuntos
- fechas
- participantes

La evidencia nunca cambia.

---

## Source

Origen desde el cual se obtuvo la información.

Ejemplos:

- Exportación de WhatsApp
- Sincronización de WhatsApp

---

## ImportJob

Proceso mediante el cual se incorpora información al sistema.

Permite mantener trazabilidad de las importaciones.

---

## Entity

Elemento identificado dentro de un mensaje.

Ejemplos:

- Persona
- Lugar
- Fecha
- Hora
- Institución
- Actividad
- Dinero

---

## Case

Tema o asunto continuo tratado en la conversación.

Un Case puede abarcar semanas, meses o incluso años.

Ejemplos:

- Viajes
- Trabajo
- Salud
- Finanzas
- Planes

Un Case agrupa múltiples eventos relacionados.

---

## Event

Suceso específico ocurrido dentro de un Case.

Un evento puede involucrar uno o varios mensajes.

Ejemplos:

- Propuesta
- Acuerdo
- Rechazo
- Cambio de horario
- Discusión

---

## Relationship

Relación entre dos elementos del dominio.

Ejemplos:

- Un evento pertenece a un Case.
- Un mensaje evidencia un evento.
- Un participante participa en un evento.

---

## Analysis

Interpretación realizada por un modelo de inteligencia artificial.

Nunca representa una verdad absoluta.

Siempre puede regenerarse.

Ejemplos:

- Nivel de conflicto
- Tono
- Empatía
- Formalidad

---

## Observation

Conclusión preliminar generada por IA.

Representa una hipótesis basada en la evidencia.

Puede convertirse posteriormente en un Insight.

---

## Insight

Conocimiento consolidado obtenido a partir de múltiples evidencias y análisis.

Un Insight representa una conclusión útil para el usuario.

Ejemplos:

- La mayoría de las propuestas de reunión fueron rechazadas.
- Los desacuerdos aumentan durante los fines de semana.
- Las conversaciones sobre el presupuesto suelen resolverse rápidamente.

---

## Summary

Resumen generado automáticamente.

Puede representar:

- un día
- una semana
- un mes
- un Case
- una conversación completa

---

## Embedding

Representación vectorial utilizada para búsqueda semántica.

No representa conocimiento del dominio.

Su finalidad es optimizar la recuperación de información.

---

## Search

Proceso de recuperación de información.

Tipos:

- Exact Search
- Semantic Search
- Timeline Search
- Case Search
- Evidence Search

---

## Agent

Componente encargado de responder consultas utilizando el conocimiento disponible.

El agente nunca modifica la evidencia.

El agente consume información generada por las capas inferiores.

---

## Reminder

Recordatorio generado para el usuario.

Siempre requiere aprobación antes de generar acciones externas.

---

## Draft

Mensaje sugerido por el sistema.

Nunca se envía automáticamente.

---

## Suggestion

Recomendación realizada por el sistema.

Ejemplos:

- Responder con un tono más formal.
- Esperar antes de responder.
- Adjuntar evidencia.

---

# Términos prohibidos

Los siguientes términos deben evitarse por ser ambiguos o demasiado generales.

- Dato
- Registro
- Objeto
- Item
- Cosa
- Información
- Resultado
- Documento (cuando realmente se refiere a un Message)
- Chat (cuando se refiere a una Conversation)

Siempre debe utilizarse el término específico definido en este documento.

---

# Convenciones

- Los nombres del dominio se escriben en singular.
- Cada entidad representa un concepto claramente definido.
- La terminología utilizada en el código debe coincidir con este documento.
- Los cambios en el lenguaje ubicuo deben reflejarse en toda la documentación del proyecto.

---

# Bounded Contexts

Actualmente el sistema está compuesto por un único contexto:

- Conversation Intelligence

En el futuro podrán existir contextos independientes como:

- Messaging
- Calendar
- Reminders
- Contacts
- Notifications

Cada contexto podrá tener su propio modelo y lenguaje, evitando que el dominio principal crezca sin control.

----

# Objetivo

Mantener un lenguaje consistente que permita que el dominio, el código y la documentación describan exactamente los mismos conceptos.