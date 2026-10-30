---
name: backup-manager
description: Rutina de backup/restore de PostgreSQL + pgvector con verificación de integridad. Úsala cuando el usuario pida hacer, verificar o restaurar un backup, o cuando se invoque /backup.
---

# backup-manager

## Backup

1. `pg_dump` de la base completa (evidencia + conocimiento + artefactos
   derivados — no separar, la consistencia entre tablas importa aunque los
   artefactos derivados sean regenerables).
2. Guardar también la ruta de `attachments.storage_path` como parte del
   backup si los archivos no están ya en almacenamiento durmente separado
   y respaldado.
3. Registrar el backup en `system_audit_log` (operación `backup_created`).
4. Si el backup sale del equipo local (subida a almacenamiento externo):
   cifrar antes de subir (`rules/security-privacy.md`).

## Verificación de integridad (obligatoria, no opcional)

No basta con copiar el archivo. Verificar:

1. El dump abre sin error (`pg_restore --list` o equivalente antes de una
   restauración real).
2. El conteo de filas de `messages` en el backup coincide con el conteo
   esperado al momento del backup (registrado en el propio job de backup).
3. Al menos una restauración de prueba periódica en una base temporal,
   no solo confiar en que "el archivo existe".

Un backup que no se ha verificado no cuenta como backup.

## Restore

1. Restaurar en una base nueva o temporal primero si hay cualquier duda.
2. Nunca restaurar sobre la base de producción sin backup del estado
   actual primero (no perder evidencia reciente al restaurar una copia
   vieja).
3. Registrar la restauración en `system_audit_log`.

## Frecuencia

No fijada aquí — es un parámetro de la Governance Layer
(`docs/ARCHITECTURE.md`, "Configuración del sistema" → "frecuencia de
backups"). Sugerencia de arranque razonable para un proyecto de un solo
usuario: backup diario incremental + semanal completo, ajustar según
volumen real una vez haya datos.
