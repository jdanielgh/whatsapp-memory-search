# SECURITY.md

# WhatsApp Memory Search

## Propósito

Este documento define los principios y mecanismos de seguridad del sistema.

El objetivo es proteger la evidencia, el conocimiento derivado y la privacidad del usuario sin comprometer la trazabilidad ni la auditabilidad.

---

# Principios

## SEC-001

La conversación pertenece exclusivamente al usuario.

---

## SEC-002

La evidencia tiene prioridad sobre la conveniencia.

Nunca debe modificarse para resolver un problema de seguridad.

---

## SEC-003

Todo acceso debe ser explícito.

---

## SEC-004

El principio de menor privilegio aplica a todos los componentes.

Cada módulo solo puede acceder a la información que necesita.

---

## SEC-005

Toda operación relevante debe ser auditada.

---

## SEC-006

La seguridad debe diseñarse desde la arquitectura, no añadirse posteriormente.

---

# Protección de la Evidencia

La evidencia representa el activo más importante del sistema.

Incluye:

* Conversation
* Participant
* Message
* Attachment

La evidencia debe ser:

* persistente
* inmutable
* verificable
* auditable

Nunca puede ser modificada por procesos automáticos.

---

# Protección del Conocimiento

Los artefactos derivados incluyen:

* Analysis
* Observation
* Insight
* Summary
* Embedding

Estos elementos pueden regenerarse.

No representan la fuente de verdad.

---

# Control de Acceso

## Usuario

Puede:

* importar conversaciones
* realizar consultas
* crear recordatorios
* solicitar borradores
* iniciar reprocesamientos

---

## Sistema

Puede:

* ejecutar pipelines
* generar conocimiento
* actualizar índices
* regenerar artefactos derivados

Nunca puede modificar evidencia.

---

# Aislamiento entre Módulos

Cada Bounded Context debe limitar el acceso a sus propios datos.

Ejemplo

```text id="vkl4z5"
Archive

↓

Knowledge

↓

Search

↓

Assistant
```

Un contexto nunca debe escribir directamente en otro.

La comunicación debe realizarse mediante interfaces definidas.

---

# Cifrado

La información persistente debe almacenarse utilizando mecanismos de cifrado proporcionados por la infraestructura.

Se recomienda proteger especialmente:

* archivos adjuntos
* copias de respaldo
* secretos
* credenciales

---

# Gestión de Secretos

Las credenciales nunca deben almacenarse en:

* código fuente
* repositorios
* archivos de configuración versionados
* prompts

Deben gestionarse mediante un sistema seguro de secretos o variables de entorno.

---

# Información Sensible

El sistema puede contener información privada.

Ejemplos

* nombres
* teléfonos
* direcciones
* correos electrónicos
* conversaciones personales
* fotografías
* documentos

Toda información sensible debe tratarse como confidencial.

---

# Auditoría

Toda operación relevante debe registrar:

* fecha
* usuario o proceso
* operación
* recurso afectado
* resultado

La auditoría nunca debe modificar la evidencia.

---

# Versionado

Toda regeneración de conocimiento debe conservar:

* modelo utilizado
* versión
* prompt
* fecha
* configuración

Esto permite reconstruir cualquier resultado obtenido por el sistema.

---

# Integridad

El sistema debe poder verificar que:

* los mensajes no fueron alterados
* los adjuntos mantienen su referencia
* las relaciones permanecen consistentes

Cuando sea posible, se recomienda utilizar mecanismos de verificación de integridad como hashes para la evidencia y los archivos adjuntos.

---

# Disponibilidad

La indisponibilidad temporal del sistema nunca debe provocar pérdida de evidencia.

Los procesos pendientes podrán reanudarse posteriormente.

---

# Respaldo

Debe existir una estrategia de respaldo para:

* base de datos
* archivos adjuntos
* configuración

Los respaldos deben permitir restaurar completamente la conversación.

---

# Registro de Eventos

Se recomienda registrar eventos de seguridad como:

* errores de autenticación
* accesos denegados
* modificaciones de configuración
* reprocesamientos masivos
* fallos críticos

---

# Protección frente a IA

Los modelos de IA nunca deben:

* modificar evidencia
* eliminar información
* sobrescribir conocimiento histórico
* ejecutar acciones sin autorización del usuario

La IA únicamente propone.

El sistema decide.

---

# Validación de Entradas

Toda entrada externa debe validarse antes de ser procesada.

Ejemplos

* archivos
* mensajes
* consultas
* parámetros
* configuraciones

La validación debe ocurrir antes de la persistencia o del procesamiento.

---

# Dependencias Externas

Los servicios externos deben considerarse no confiables.

Toda respuesta proveniente de un proveedor externo debe validarse antes de incorporarse al sistema.

---

# Privacidad

El sistema está diseñado para un único propietario de la conversación.

No contempla acceso multiusuario ni compartición de conversaciones.

La privacidad del usuario tiene prioridad sobre cualquier optimización.

---

# Restricciones

Nunca registrar secretos en logs.

Nunca almacenar credenciales en texto plano.

Nunca modificar evidencia para corregir errores.

Nunca confiar en datos externos sin validación.

Nunca permitir que un modelo de IA ejecute acciones irreversibles.

Nunca eliminar registros de auditoría.

---

# Objetivo

Garantizar la confidencialidad, integridad y disponibilidad de la conversación y del conocimiento derivado, preservando siempre la evidencia como fuente única de verdad y asegurando que toda acción realizada por el sistema sea verificable, auditable y reversible cuando corresponda.
