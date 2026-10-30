# SYSTEM_INVARIANTS.md

# Conversation Memory Assistant

## Propósito

Este documento define las reglas fundamentales que gobiernan el sistema.

Estas reglas son invariantes: deben cumplirse siempre, independientemente de la implementación, la tecnología utilizada o el modelo de IA empleado.

Toda nueva funcionalidad debe respetar estas reglas.

---

# Evidencia

### SI-001

La evidencia es la fuente única de verdad.

---

### SI-002

Todo Message es inmutable.

---

### SI-003

Un Message nunca puede eliminarse.

---

### SI-004

Un Attachment nunca puede existir sin un Message.

---

### SI-005

Todo Message pertenece exactamente a una Conversation.

---

### SI-006

Todo Message tiene exactamente un Participant.

---

### SI-007

La evidencia nunca puede modificarse como resultado de un análisis de IA.

---

### SI-008

La evidencia conserva siempre su contenido original.

---

# Conversación

### SI-009

Una Conversation es el contenedor principal del sistema.

---

### SI-010

Todos los objetos del dominio deben pertenecer, directa o indirectamente, a una Conversation.

---

### SI-011

Los Participants pertenecen a una única Conversation.

---

# Conocimiento

### SI-012

Todo Event pertenece a un único Case.

---

### SI-013

Un Case puede contener múltiples Events.

---

### SI-014

Un Event puede estar respaldado por uno o varios Messages.

---

### SI-015

Todo Insight debe estar respaldado por evidencia.

---

### SI-016

Un Insight nunca modifica la evidencia.

---

### SI-017

Los Relationships nunca crean evidencia.

Únicamente describen relaciones existentes.

---

# Inteligencia Artificial

### SI-018

La IA nunca modifica la evidencia.

---

### SI-019

Todo Analysis debe indicar el modelo utilizado.

---

### SI-020

Todo Analysis debe indicar la versión del prompt.

---

### SI-021

Todo Analysis debe indicar la fecha de generación.

---

### SI-022

Todo Analysis puede regenerarse.

---

### SI-023

Todo Analysis debe poder eliminarse sin afectar la evidencia.

---

### SI-024

Toda conclusión generada por IA debe indicar su evidencia.

---

### SI-025

Toda conclusión probabilística debe indicar un nivel de confianza.

---

### SI-026

Ningún Analysis representa una verdad absoluta.

---

# Embeddings

### SI-027

Los Embeddings nunca representan conocimiento.

---

### SI-028

Los Embeddings pueden regenerarse en cualquier momento.

---

### SI-029

La eliminación de Embeddings nunca afecta la evidencia.

---

# Procesamiento

### SI-030

Todo Message debe poder reprocesarse.

---

### SI-031

El procesamiento debe ser idempotente.

---

### SI-032

El fallo de una etapa nunca elimina información.

---

### SI-033

Las etapas del pipeline deben ser independientes.

---

### SI-034

El procesamiento nunca bloquea la persistencia de mensajes.

---

# Búsqueda

### SI-035

Toda búsqueda debe priorizar evidencia sobre interpretación.

---

### SI-036

Las búsquedas semánticas nunca reemplazan las búsquedas exactas.

---

### SI-037

Toda respuesta debe poder reconstruirse desde la evidencia.

---

# Asistente

### SI-038

El Assistant nunca modifica la evidencia.

---

### SI-039

El Assistant nunca envía mensajes automáticamente.

---

### SI-040

Toda acción externa requiere autorización explícita del usuario.

---

### SI-041

El Assistant utiliza exclusivamente el Search Layer para recuperar información.

---

# Persistencia

### SI-042

Toda entidad posee un identificador único e inmutable.

---

### SI-043

La evidencia nunca utiliza soft delete.

---

### SI-044

Todo dato derivado puede regenerarse.

---

### SI-045

Toda operación importante debe ser trazable.

---

# Evolución

### SI-046

El sistema debe permitir incorporar nuevos modelos de IA sin modificar el dominio.

---

### SI-047

El sistema debe permitir reconstruir completamente el conocimiento.

---

### SI-048

Las reglas del dominio son independientes de la infraestructura.

---

### SI-049

La sustitución de una tecnología no debe modificar el modelo del dominio.

---

### SI-050

Toda nueva funcionalidad debe respetar las reglas definidas en este documento.