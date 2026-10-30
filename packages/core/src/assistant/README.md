# assistant

Agent Layer + modelo del asistente: `Reminder`, `Draft`, `Suggestion`.
El agente nunca modifica evidencia, nunca envía mensajes automáticamente
(SI-038/SI-039), siempre usa `search/` para recuperar información
(SI-041).

Draft debe usar tono neutral/factual por defecto — la
conversación podría usarse como evidencia, ver `rules/security-privacy.md` regla 7 y
`plans/`.
