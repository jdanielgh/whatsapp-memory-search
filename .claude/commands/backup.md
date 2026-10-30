---
description: Ejecutar un backup verificado de la base de datos siguiendo backup-manager.
---

Ejecuta un backup siguiendo la skill `backup-manager`, incluyendo la
verificación de integridad (no solo copiar el archivo — confirmar que
abre y que el conteo de filas coincide).

Esta es una tarea mecánica y ruidosa: delega en el subagente
`pipeline-ops` y trae de vuelta solo el resultado (éxito/fallo, tamaño,
conteo verificado, si se cifró por salir del equipo local).

$ARGUMENTS
