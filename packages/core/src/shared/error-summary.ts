// Resumen de un error apto para persistir (import_jobs.error_summary,
// system_audit_log) o imprimir en consola sin filtrar contenido de
// mensajes (rules/security-privacy.md, regla 1).
//
// drizzle-orm >= 0.44 envuelve todo error de query en DrizzleQueryError,
// cuyo `message` incluye el SQL y sus parámetros — en un INSERT sobre
// `messages`, eso es el contenido literal. El error real del driver
// (p. ej. "permission denied for table messages") queda en `cause`, así
// que se reporta la causa más interna en vez del envoltorio.
export function errorSummary(err: unknown): string {
  let current = err;
  while (current instanceof Error && current.cause instanceof Error) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(err);
}
