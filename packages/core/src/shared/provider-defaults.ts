// Motores de IA por defecto (plans/). Viven en un módulo
// propio, sin dependencias, para poder comprobar en un test que son nombres
// realmente registrados: un error de tipeo aquí rompería el arranque de todos
// los CLIs.
//
// - Completions: `claude-code`, que consume la cuota de una suscripción en
//   lugar de saldo de API. Pasó la calificación del plan 13 (sección 6). Quien
//   no tenga Claude Code recibe un error de arranque explícito que indica cómo
//   resolverlo o cambiar a `anthropic-api`.
// - Embeddings: `voyage`, dentro de su cuota gratuita.

export const DEFAULT_AI_PROVIDER = "claude-code";
export const DEFAULT_EMBEDDING_PROVIDER = "voyage";
