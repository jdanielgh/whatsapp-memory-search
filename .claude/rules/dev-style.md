# dev-style

Sin TDD estricto ni cobertura obligatoria (proyecto personal).

1. Archivos pequeños, un módulo = una responsabilidad (`docs/ARCHITECTURE.md`).
2. Sin `console.log` de debug en el pipeline productivo.
3. Nomenclatura = `docs/UBIQUITOUS_LANGUAGE.md`; evita sus "términos
   prohibidos" (Dato, Registro, Objeto, Item, Información, Resultado...).
4. Test obligatorio donde un fallo sería silencioso y causaría pérdida de
   datos o contexto falso: parser de ingesta (`whatsapp-ingest`),
   recuperación RAG (`rag-retrieval`), y cualquier código que escriba
   evidencia inmutable (repositorios/casos de uso de `archive/`) — este
   último con tests de integración contra Postgres efímero, no fakes
   solamente, porque el riesgo específico es la interacción real con SQL.
   El resto, validación manual.
5. Antes de mergear a `main`: `npm run verify` (typecheck + unit +
   integration) en verde. Automatizado en CI apenas se configure.
