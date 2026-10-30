# USE_CASES.md

# Conversation Memory Assistant

## Propósito

Este documento describe los casos de uso del sistema desde la perspectiva del usuario y del dominio.

Cada caso de uso representa una capacidad del sistema, independientemente de la interfaz o de la tecnología utilizada.

---

# Actores

## Usuario

Propietario de la conversación.

Puede importar información, consultar conocimiento, administrar recordatorios y solicitar asistencia.

---

## Sistema

Responsable de procesar información, generar conocimiento y mantener la consistencia del dominio.

---

# UC-001 Importar conversación

## Objetivo

Registrar una conversación exportada desde WhatsApp.

### Actor

Usuario

### Precondiciones

* Existe un archivo válido de exportación.

### Flujo

1. El usuario selecciona un archivo.
2. El sistema valida el formato.
3. El sistema crea un ImportJob.
4. El sistema importa los participantes.
5. El sistema importa los mensajes.
6. El sistema registra los adjuntos.
7. El sistema inicia el procesamiento.

### Resultado

Toda la conversación queda almacenada como evidencia.

---

# UC-002 Sincronizar nuevos mensajes

## Objetivo

Incorporar nuevos mensajes sin afectar la evidencia existente.

### Actor

Sistema

### Flujo

1. Detectar nuevos mensajes.
2. Evitar duplicados.
3. Registrar evidencia.
4. Ejecutar el pipeline.

### Resultado

La conversación permanece actualizada.

---

# UC-003 Consultar un mensaje

## Objetivo

Recuperar un mensaje específico.

### Actor

Usuario

### Ejemplos

* Mostrar el mensaje del 12 de marzo.
* Buscar un mensaje específico.

### Resultado

Se devuelve evidencia original.

---

# UC-004 Buscar mensajes

## Objetivo

Buscar mensajes mediante distintos criterios.

### Actor

Usuario

### Criterios

* Texto
* Fecha
* Participante
* Intervalo
* Palabras clave

### Resultado

Lista de mensajes coincidentes.

---

# UC-005 Buscar por similitud

## Objetivo

Encontrar mensajes relacionados semánticamente.

### Actor

Usuario

### Ejemplos

* Conversaciones sobre vacaciones.
* Mensajes relacionados con el presupuesto.

### Resultado

Mensajes similares ordenados por relevancia.

---

# UC-006 Detectar entidades

## Objetivo

Extraer entidades presentes en los mensajes.

### Actor

Sistema

### Ejemplos

* Personas
* Lugares
* Fechas
* Horarios
* Instituciones
* Cantidades

### Resultado

Las entidades quedan asociadas al mensaje.

---

# UC-007 Detectar eventos

## Objetivo

Identificar eventos relevantes.

### Actor

Sistema

### Ejemplos

* Propuesta
* Rechazo
* Acuerdo
* Cambio de horario
* Discusión

### Resultado

Se registra un Event.

---

# UC-008 Gestionar Cases

## Objetivo

Agrupar eventos relacionados.

### Actor

Sistema

### Flujo

1. Detectar un nuevo Event.
2. Buscar Cases existentes.
3. Asociar el Event.
4. Crear un nuevo Case si es necesario.

### Resultado

El conocimiento permanece organizado.

---

# UC-009 Generar Insights

## Objetivo

Consolidar conocimiento útil para el usuario.

### Actor

Sistema

### Ejemplos

* Patrones de comportamiento.
* Frecuencia de acuerdos.
* Tendencias.
* Temas recurrentes.

### Resultado

Se generan nuevos Insights.

---

# UC-010 Generar resúmenes

## Objetivo

Resumir información.

### Actor

Usuario

### Tipos

* Diario
* Semanal
* Mensual
* Por Case
* Conversación completa

---

# UC-011 Consultar un Case

## Objetivo

Visualizar toda la información relacionada con un tema.

### Actor

Usuario

### Resultado

El sistema devuelve:

* Eventos
* Evidencia
* Insights
* Resúmenes

---

# UC-012 Consultar cronología

## Objetivo

Visualizar eventos ordenados temporalmente.

### Actor

Usuario

### Ejemplos

* Última semana.
* Último mes.
* Intervalo personalizado.

---

# UC-013 Consultar evidencia

## Objetivo

Visualizar la evidencia utilizada para responder una consulta.

### Actor

Usuario

### Resultado

El sistema devuelve los mensajes originales.

---

# UC-014 Responder preguntas

## Objetivo

Responder consultas en lenguaje natural.

### Actor

Usuario

### Ejemplos

¿Cuándo rechazó una reunión?

¿Cuántas veces cambiamos el horario?

¿Quién propuso el viaje?

### Resultado

Respuesta acompañada de evidencia.

---

# UC-015 Detectar patrones

## Objetivo

Identificar comportamientos repetitivos.

### Actor

Usuario

### Ejemplos

* Frecuencia de conflictos.
* Horarios habituales.
* Cambios recurrentes.

---

# UC-016 Crear recordatorio

## Objetivo

Registrar una acción futura.

### Actor

Usuario

### Resultado

Se crea un Reminder.

---

# UC-017 Gestionar recordatorios

## Objetivo

Modificar el estado de un recordatorio.

### Actor

Usuario

### Acciones

* Completar.
* Posponer.
* Cancelar.

---

# UC-018 Generar borrador

## Objetivo

Redactar un mensaje.

### Actor

Usuario

### Ejemplos

* Respuesta cordial.
* Respuesta formal.
* Respuesta basada en evidencia.

### Resultado

Se genera un Draft.

---

# UC-019 Explicar una respuesta

## Objetivo

Mostrar cómo el sistema llegó a una conclusión.

### Actor

Usuario

### Resultado

La respuesta incluye:

* Evidencia.
* Events.
* Cases.
* Nivel de confianza.

---

# UC-020 Reprocesar conocimiento

## Objetivo

Actualizar el conocimiento utilizando nuevos modelos de IA.

### Actor

Sistema

### Flujo

1. Seleccionar artefactos derivados.
2. Ejecutar nuevamente el pipeline.
3. Crear nuevas versiones.
4. Mantener la evidencia intacta.

---

# UC-021 Reconstruir conocimiento

## Objetivo

Reconstruir completamente el conocimiento del sistema.

### Actor

Sistema

### Resultado

Se regeneran:

* Analysis
* Observations
* Embeddings
* Summaries
* Insights

Sin modificar la evidencia.

---

# UC-022 Consultar historial de un participante

## Objetivo

Visualizar toda la actividad de un participante.

### Actor

Usuario

### Resultado

Cronología completa de mensajes, eventos y participación en Cases.

---

# UC-023 Consultar estadísticas

## Objetivo

Obtener métricas de la conversación.

### Actor

Usuario

### Ejemplos

* Número de mensajes.
* Número de eventos.
* Cases abiertos.
* Recordatorios pendientes.
* Distribución por participante.

---

# UC-024 Exportar conocimiento

## Objetivo

Exportar información estructurada.

### Actor

Usuario

### Formatos futuros

* JSON
* Markdown
* PDF

---

# UC-025 Auditar el sistema

## Objetivo

Consultar el historial de procesamiento.

### Actor

Usuario

### Incluye

* Importaciones.
* Reprocesamientos.
* Versiones de análisis.
* Modelos utilizados.

---

# Prioridades

## MVP

* UC-001
* UC-002
* UC-003
* UC-004
* UC-006
* UC-007
* UC-008
* UC-011
* UC-012
* UC-013
* UC-014

---

## Segunda versión

* UC-009
* UC-010
* UC-015
* UC-016
* UC-017
* UC-018
* UC-019

---

## Futuras versiones

* UC-020
* UC-021
* UC-022
* UC-023
* UC-024
* UC-025

---

# Objetivo

Todos los casos de uso deben preservar la evidencia, enriquecer el conocimiento del sistema y proporcionar respuestas verificables respaldadas por la conversación original.
