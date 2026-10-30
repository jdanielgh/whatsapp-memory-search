# ARCHITECTURE.md

# WhatsApp Memory Search

## Arquitectura del sistema

Este documento describe la arquitectura general del proyecto y las decisiones técnicas que guían su implementación.

El objetivo principal es construir un sistema capaz de preservar una conversación de WhatsApp, transformarla progresivamente en conocimiento estructurado y permitir consultas inteligentes mediante un agente de IA.

La arquitectura prioriza:

- Integridad de la evidencia.
- Simplicidad.
- Bajo acoplamiento.
- Evolución incremental.
- Optimización de costos de IA.
- Reprocesamiento sencillo cuando existan mejores modelos.

---

# Filosofía

La inteligencia artificial no es el centro del sistema.

El centro del sistema es la conversación.

La IA únicamente transforma evidencia en conocimiento y ayuda a responder preguntas.

Toda la arquitectura gira alrededor de preservar la evidencia original.

---

# Principios arquitectónicos

## 1. La evidencia es inmutable

Los mensajes originales nunca pueden modificarse.

Todas las operaciones posteriores generan nuevas capas de información sin alterar el contenido original.

---

## 2. El conocimiento es derivado

Todo análisis realizado por IA puede regenerarse.

Si aparece un mejor modelo, el sistema puede reconstruir completamente el conocimiento sin afectar la evidencia.

---

## 3. Todo debe ser trazable

Cada respuesta generada por el agente debe poder indicar:

- mensajes utilizados
- eventos relacionados
- nivel de confianza

---

## 4. Procesamiento desacoplado

Guardar información nunca depende de la IA.

Primero se almacena.

Después se analiza.

---

## 5. El agente nunca es la fuente de verdad

El agente únicamente consume conocimiento.

Nunca escribe directamente sobre la evidencia.

---

# Arquitectura general

```
                    WhatsApp
                        │
                        ▼
                 Importador
                        │
                        ▼
               Archive Layer
                        │
                        ▼
             Processing Pipeline
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
 Knowledge Layer                 AI Analysis Layer
        │                               │
        └───────────────┬───────────────┘
                        ▼
                  Search Layer
                        │
                        ▼
                    Agent Layer
                        │
                        ▼
                 API / Interfaces
```

Toda la información fluye en una única dirección.

No existen modificaciones hacia atrás.

---

# Capas

## Archive Layer

Responsabilidad:

Preservar la evidencia.

Componentes:

- Conversation
- Message
- Attachment
- ImportJob
- Source

Nunca ejecuta IA.

Nunca interpreta información.

---

## Processing Layer

Responsabilidad:

Transformar evidencia en conocimiento.

Se ejecuta después de almacenar un mensaje.

Pipeline:

1. Validación
2. Persistencia
3. Extracción de metadata
4. Extracción de entidades
5. Clasificación
6. Detección de eventos
7. Asociación de Cases
8. Generación de Insights
9. Generación de Embeddings
10. Actualización de índices

Cada etapa es independiente.

Cada etapa puede volver a ejecutarse.

---

## Knowledge Layer

Representa el conocimiento estructurado del sistema.

Entidades principales:

- Case
- Event
- Insight
- Relationship

Esta capa responde la mayoría de consultas sin necesidad de analizar nuevamente el historial completo.

---

## AI Analysis Layer

Responsabilidad:

Realizar análisis utilizando modelos de lenguaje.

Produce:

- Analysis
- Summary
- Embeddings
- Observations

Nunca modifica mensajes.

Nunca elimina información.

---

## Search Layer

Proporciona mecanismos especializados para recuperar información.

Tipos de búsqueda:

### Exact Search

Búsqueda por:

- texto
- fecha
- participante
- tipo

---

### Semantic Search

Utiliza embeddings.

Se emplea para preguntas en lenguaje natural.

---

### Timeline Search

Recupera información por rangos de tiempo.

---

### Case Search

Recupera toda la información relacionada con un tema específico.

---

### Evidence Search

Devuelve mensajes originales.

Siempre prioriza evidencia sobre interpretaciones.

---

## Agent Layer

Responsabilidad:

Responder consultas utilizando el conocimiento disponible.

El agente nunca consulta directamente la base de datos.

Siempre utiliza el Search Layer.

Responsabilidades:

- responder preguntas
- generar resúmenes
- redactar mensajes
- generar recordatorios

---

## Interface Layer

Representa los puntos de entrada al sistema.

Inicialmente:

- REST API

En el futuro:

- Web UI
- CLI
- Aplicación móvil

---

# Flujo de procesamiento

## Importación inicial

WhatsApp Export

↓

Parser

↓

Persistencia

↓

Pipeline

↓

Knowledge Base

↓

Embeddings

↓

Ready

---

## Mensajes nuevos

WhatsApp

↓

Webhook

↓

Persistencia

↓

Pipeline

↓

Knowledge Base

↓

Embeddings

↓

Ready

---

## Consulta

Usuario

↓

Agent

↓

Search Layer

↓

Knowledge

↓

Evidence

↓

LLM

↓

Respuesta

---

# Monorepo

npm workspaces (`package.json` de la raíz):

```
packages/
  core/          ← dominio, pipelines y CLIs (@cma/core)
    src/         ← módulos de abajo
    scripts/     ← smoke tests, regresión, diagnósticos
apps/            ← aplicaciones desplegables que consumen @cma/core
                   (API HTTP, UI, receptor de webhooks)
```

`.env`, `docs/`, `plans/`, `.claude/`, `backups/` y `docker-compose.yml`
viven en la raíz. Los comandos (`npm run verify`, `npm run sync`, …) se
lanzan desde la raíz y se delegan al workspace. Las rutas de runtime se
anclan a la raíz con `packages/core/src/shared/repo-paths.ts`, nunca al
directorio actual.

# Arquitectura modular

```
packages/core/src/

archive/

conversation/

knowledge/

processing/

analysis/

search/

assistant/

api/

infrastructure/

shared/
```

Cada módulo posee:

- dominio
- casos de uso
- repositorios
- infraestructura

---

# Procesamiento asíncrono

Todo análisis de IA ocurre en segundo plano.

Guardar mensajes nunca depende del resultado del análisis.

Si el procesamiento falla:

- el mensaje permanece almacenado
- el trabajo puede reintentarse

---

# Gestión del conocimiento

El conocimiento siempre se construye en capas.

```
Evidence

↓

Metadata

↓

Entities

↓

Events

↓

Insights

↓

Embeddings
```

Cada capa depende únicamente de la anterior.

---

# Estados del procesamiento

Todo mensaje pasa por un ciclo de vida.

NEW

↓

IMPORTED

↓

PROCESSED

↓

CLASSIFIED

↓

INDEXED

↓

READY

Si una etapa falla, el mensaje conserva su estado anterior.

---

# Integraciones

## WhatsApp

Fuente principal de información.

---

## Anthropic

Proveedor principal de IA.

Se utiliza únicamente para:

- clasificación
- extracción
- resúmenes
- respuestas

---

## PostgreSQL

Fuente de verdad del sistema.

---

## pgvector

Motor de búsqueda semántica.

---

# Decisiones arquitectónicas

## No utilizar múltiples agentes

Se utilizará un único pipeline determinista.

Razones:

- menor complejidad
- menor costo
- mayor trazabilidad

---

## IA desacoplada

Toda interacción con modelos debe realizarse mediante una abstracción.

Nunca depender directamente de un proveedor específico.

En la práctica:

- El dominio depende de dos interfaces (`AIProvider` para completions y
  `EmbeddingBatchProvider` para embeddings, en `infrastructure/ai/provider.ts`).
- Ningún CLI, script ni caso de uso construye un proveedor concreto: lo pide
  a una fábrica (`infrastructure/ai/factory.ts`), que lo resuelve por nombre
  desde la configuración. La fábrica es el único lugar que conoce las clases.
- Cada proveedor declara sus capacidades: cómo se factura, si los datos salen
  del equipo y si fuerza el esquema de salida. Cada corrida lo imprime y lo
  registra en la auditoría.
- Un fallo del motor se lanza y corta la corrida; una respuesta mal formada
  del modelo se devuelve como texto y la rechaza el parser por mensaje.

Qué motores existen, cómo elegir uno y cómo agregar otro:
`docs/AI_PROVIDERS.md`.

---

## Evidencia primero

Toda respuesta debe construirse priorizando evidencia antes que interpretación.

---

## Preparado para reanálisis

El sistema debe permitir reconstruir completamente:

- análisis
- embeddings
- insights
- resúmenes

sin volver a importar la conversación.

---

# Governance Layer

## Responsabilidad

La Governance Layer agrupa todas las políticas transversales del sistema.

No forma parte del dominio ni del flujo de procesamiento.

Su objetivo es garantizar que el sistema opere de forma consistente, segura, auditable y configurable sin mezclar estas responsabilidades con la lógica de negocio.

Esta capa aplica sobre todos los módulos del sistema.

---

## Responsabilidades

### Auditoría

Registrar eventos importantes del sistema.

Ejemplos:

- Importaciones ejecutadas.
- Consultas realizadas.
- Reprocesamientos.
- Errores.
- Cambios de configuración.

---

### Versionado de análisis

Toda información generada por IA debe ser versionable.

Un nuevo modelo nunca sobrescribe un análisis anterior.

El sistema conserva el historial completo de versiones para permitir comparaciones y reprocesamientos.

---

### Configuración de IA

Centralizar la configuración relacionada con modelos de lenguaje.

Ejemplos:

- proveedor
- modelo
- temperatura
- prompts
- estrategias de recuperación
- límites de contexto

La lógica del dominio nunca debe depender directamente de estos valores.

---

### Reglas de privacidad

Aplicar restricciones de acceso a información sensible.

Ejemplos:

- excluir conversaciones íntimas por defecto
- ocultar contenido clasificado como +18
- requerir autorización explícita para mostrar información sensible

Estas reglas pueden modificarse sin afectar el dominio.

---

### Configuración del sistema

Centralizar parámetros globales.

Ejemplos:

- frecuencia de backups
- tamaño de embeddings
- estrategias de indexación
- políticas de reprocesamiento
- límites de almacenamiento

---

### Observabilidad

Facilitar el monitoreo del sistema.

Incluye:

- métricas
- logs
- tiempos de procesamiento
- consumo de IA
- estado de pipelines

---

## Principios

La Governance Layer nunca modifica la evidencia.

La Governance Layer nunca contiene reglas del negocio.

La Governance Layer únicamente controla cómo opera el sistema.

---

## Alcance

Esta capa afecta transversalmente a:

- Archive Layer
- Processing Layer
- Knowledge Layer
- AI Analysis Layer
- Search Layer
- Agent Layer
- Interface Layer

Sin generar dependencias entre ellas.

### Cost Management

Controlar el consumo de recursos asociados a la inteligencia artificial.

Incluye:

- seguimiento de tokens consumidos
- coste por proveedor
- coste por análisis
- coste por conversación
- políticas de reutilización de resultados
- caché de respuestas cuando sea posible

La optimización de costes es un objetivo arquitectónico del sistema y no una preocupación del dominio.

# Objetivo final

Construir un motor de memoria conversacional donde la evidencia permanezca intacta, el conocimiento evolucione continuamente y el agente actúe únicamente como una interfaz inteligente para consultar esa información.