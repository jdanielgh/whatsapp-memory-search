#!/usr/bin/env bash
# Deterministic hook, no LLM calls. Runs on SessionStart.
# Prints a tiny status readout so the session starts oriented without
# re-reading code or history. The status file is written by the app
# itself (whatsapp-ingest / backup-manager should update it after each
# run) — this hook only reads it.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
STATUS_FILE="$PROJECT_DIR/.claude/state/status.json"

if [ ! -f "$STATUS_FILE" ]; then
  echo "WhatsApp Memory Search — sin estado registrado todavía."
  echo "No se ha corrido ninguna importación ni backup en este entorno,"
  echo "o .claude/state/status.json aún no existe."
  echo "Ver skill whatsapp-ingest para importar, o backup-manager para restaurar."
  exit 0
fi

if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    try {
      const s = JSON.parse(fs.readFileSync(path, "utf8"));
      console.log("WhatsApp Memory Search — estado:");
      console.log("  Última importación: " + (s.last_import_at ?? "nunca"));
      console.log("  Mensajes: " + (s.message_count ?? "?"));
      console.log("  Cases abiertos: " + (s.open_cases_count ?? "?"));
      console.log("  Recordatorios pendientes: " + (s.pending_reminders_count ?? "?"));
      console.log("  Último backup: " + (s.last_backup_at ?? "nunca"));
    } catch (e) {
      console.log("Estado presente pero no se pudo leer (" + e.message + ").");
    }
  ' "$STATUS_FILE"
else
  echo "Estado registrado en $STATUS_FILE (node no disponible para formatear)."
fi
