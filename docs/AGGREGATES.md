# AGGREGATES.md

# Conversation Memory Assistant

## Propósito

Este documento define los **Aggregates** del dominio y sus límites de consistencia.

Los Aggregates establecen:

* Qué entidades forman una unidad lógica.
* Qué objeto actúa como punto de entrada (Aggregate Root).
* Qué reglas de negocio deben mantenerse consistentes.
* Cómo se relacionan los distintos Aggregates.

Este documento es independiente de la base de datos y de cualquier tecnología utilizada.

---

# Principios

## AG-001

Todo Aggregate tiene exactamente un **Aggregate Root**.

---

## AG-002

Los consumidores externos solo interactúan con el Aggregate Root.

Nunca con las entidades internas.

---

## AG-003

Los Aggregates se relacionan mediante identificadores.

Nunca mediante referencias directas a objetos internos.

---

## AG-004

Cada Aggregate es responsable de mantener sus propias invariantes.

---

## AG-005

Los cambios deben mantenerse dentro del mismo Aggregate siempre que sea posible.

---

# Aggregate: Conversation

## Aggregate Root

**Conversation**

## Propósito

Representa una conversación completa y toda su evidencia.

Es el Aggregate principal del sistema.

## Contiene

```text
Conversation
├── Participant
├── Message
└── Attachment
```

## Responsabilidades

* Registrar participantes.
* Registrar mensajes.
* Preservar la evidencia.
* Garantizar la integridad de la conversación.

## Invariantes

* Todo Message pertenece a una Conversation.
* Todo Participant pertenece a una Conversation.
* Todo Attachment pertenece a un Message.
* Los Messages son inmutables.
* La evidencia nunca se elimina.

## Referencias

Puede ser referenciado por:

* Case
* ImportJob
* Reminder

---

# Aggregate: Case

## Aggregate Root

**Case**

## Propósito

Representa un tema de negocio que evoluciona en el tiempo.

Ejemplos:

* Planes de viaje
* Trabajo
* Salud
* Finanzas
* Planes

## Contiene

```text
Case
├── Event
├── Insight
└── Relationship
```

## Responsabilidades

* Agrupar eventos relacionados.
* Mantener el contexto del caso.
* Consolidar conocimiento.

## Invariantes

* Todo Event pertenece a un único Case.
* Todo Insight pertenece a un único Case.
* Todo Relationship pertenece a un único Case.

## Referencias

Hace referencia a:

* Conversation

Puede ser referenciado por:

* Reminder

---

# Aggregate: Reminder

## Aggregate Root

**Reminder**

## Propósito

Representa una acción futura sugerida o creada para el usuario.

## Contiene

```text
Reminder
```

## Responsabilidades

* Mantener fecha objetivo.
* Mantener estado.
* Mantener autorización del usuario.

## Invariantes

* Nunca se ejecuta automáticamente.
* Siempre requiere aprobación del usuario.

## Referencias

Puede referenciar:

* Conversation
* Case
* Event

---

# Aggregate: ImportJob

## Aggregate Root

**ImportJob**

## Propósito

Registrar cada proceso de importación realizado por el sistema.

## Contiene

```text
ImportJob
└── Source
```

## Responsabilidades

* Registrar el origen de la información.
* Registrar fecha y estado.
* Mantener trazabilidad.

## Invariantes

* Todo ImportJob pertenece a una Conversation.
* Todo ImportJob tiene un Source.
* Una importación nunca modifica evidencia existente.

---

# Artefactos Derivados

Los siguientes elementos **no son Aggregates**.

Son resultados de procesos automáticos y pueden regenerarse en cualquier momento.

* Analysis
* Observation
* Summary
* Embedding

## Reglas

* No poseen identidad de negocio propia.
* No tienen repositorios independientes.
* Siempre pertenecen a un Aggregate existente.
* Nunca modifican la evidencia.
* Pueden eliminarse y regenerarse.

---

# Relaciones entre Aggregates

```text
Conversation
│
├── Case
│     ├── Event
│     ├── Insight
│     └── Relationship
│
├── Reminder
│
└── ImportJob
```

Los Aggregates únicamente se relacionan mediante identificadores.

---

# Repositorios

Existe exactamente un repositorio por Aggregate Root.

```text
ConversationRepository

CaseRepository

ReminderRepository

ImportJobRepository
```

No existen repositorios para entidades internas.

Ejemplos:

* ❌ MessageRepository
* ❌ EventRepository
* ❌ AttachmentRepository
* ❌ InsightRepository
* ❌ RelationshipRepository

Estas entidades son administradas exclusivamente por su Aggregate Root.

---

# Consistencia

Cada Aggregate garantiza la consistencia de sus propias entidades.

Las relaciones entre Aggregates pueden resolverse mediante referencias y procesos de sincronización, evitando transacciones distribuidas siempre que sea posible.

---

# Objetivo

Mantener límites claros entre las responsabilidades del dominio, reducir el acoplamiento y permitir que cada Aggregate evolucione de forma independiente sin comprometer la integridad del sistema.
