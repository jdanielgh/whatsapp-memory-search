# security-privacy

Datos personales de terceros reales (un chat puede incluir menores), no
seguridad de app web.

1. Nunca imprimir el contenido completo de un mensaje salvo pedido
   explícito, ni loguear `content` en texto plano (usa el `id`).
2. Datos de personas que aparecen en la conversación, en especial menores:
   nunca en ejemplos, fixtures o commits.
3. Sin claves/tokens hardcodeados; todo en variables de entorno.
4. Backups fuera del equipo local deben cifrarse (`backup-manager`).
5. Nunca `UPDATE`/`DELETE` sobre `conversations`, `participants`,
   `messages`, `attachments` (evidencia inmutable, SI-002/003/043).
   `analyses`/`observations`/`summaries`/`embeddings` sí son regenerables.
6. Toda entrada externa (export, webhook, respuesta de IA) se valida antes
   de persistir.
7. La conversación archivada podría usarse como evidencia. Cualquier
   `Draft`/`Suggestion` que se genere en el futuro (UC-018) debe tener
   tono neutral/factual por defecto, no conciliador ni agresivo. Nunca
   degradar `content_hash`, auditoría, ni trazabilidad de evidencia "por
   conveniencia", ni en detalles menores.
8. **Elegir un motor de IA es elegir a dónde van los datos.** Cada motor
   declara si el contenido de los mensajes sale del equipo
   (`capabilities.dataLeavesMachine`) y cada corrida lo imprime y lo registra
   en `system_audit_log`. `anthropic-api`, `claude-code` y `voyage` envían
   contenido a un tercero; solo un motor local lo mantiene en el equipo. Con
   datos de menores o de terceros, preferir un motor local cuando exista uno
   calificado, y nunca pasar a un motor externo nuevo sin decirlo (ver también
   `rules/ai-cost.md` regla 6).
