# ai-cost

Cualquier ejecución que consuma un recurso limitado con IA real (no tests
con fakes/mocks, ver `rules/dev-style.md`) sigue este proceso. Qué recurso se
consume depende del motor (`AI_PROVIDER`, `plans/`):

| Motor | Consume | Se mide en |
|---|---|---|
| `anthropic-api` | saldo de API (dinero) | USD |
| `claude-code` | cuota de la suscripción, compartida con el uso interactivo de Claude | llamadas, tokens y % de `/usage` |
| `local` (futuro) | tiempo y memoria de la máquina | tiempo |
| `voyage` (embeddings) | cuota gratuita del servicio; dinero si se excede | tokens |

Las reglas 1, 3 (smoke), 4 y 5 aplican a todos los motores. La 2 y la 3
(segunda revisión) se endurecen cuando hay dinero de por medio.

1. **Nunca en tests automatizados ni en CI.** `AIProvider` es una
   abstracción justamente para esto (`docs/ARCHITECTURE.md`, "IA
   desacoplada"): unit/integration tests usan un fake/stub determinista
   (mismo patrón que `FakeConversationRepository`), nunca un motor real. Un
   `push`/PR no debe gastar saldo ni cuota por sí solo — si un test necesita
   validar contra un motor real, es un smoke test manual, explícito, fuera de
   `npm run verify`.
2. **Estimación antes de correr.** Declarar motor, modelo, cantidad de
   llamadas y el consumo estimado en la unidad del motor (tabla de arriba),
   aunque sea de orden de magnitud, antes de lanzar cualquier corrida real.
   - **`anthropic-api` o Voyage fuera de su cuota gratuita (hay dinero):**
     esperar confirmación explícita del usuario, sin excepción y sin importar
     cuán chica parezca la corrida.
   - **`claude-code` o `local`:** la confirmación explícita se exige cuando
     la corrida pasa de ~100 llamadas, porque la cuota se comparte con el uso
     interactivo del usuario y una corrida grande puede dejarlo sin ella. Los
     smoke tests y las corridas chicas (hasta ~20 llamadas) no la necesitan.
   - Para estimar la cuota de una suscripción no alcanza con tokens: medir
     `/usage` antes y después de una corrida acotada (`--limit`) y extrapolar
     (método y resultados en `plans/`).
3. **Verificación antes de la corrida real**, no una sola pasada:
   - `npm run verify` (typecheck + unit + integration, todo con fakes) en
     verde.
   - Un smoke test controlado contra el motor real, con mensajes inventados
     (nunca datos reales de la conversación) que cubra los casos borde
     relevantes (salida vacía, JSON inválido, límites de longitud) y confirme
     que el parseo/validación de la respuesta funciona antes de tocar el
     backlog real.
   - **Solo con `anthropic-api`:** repetir la revisión una segunda vez, de
     forma independiente, antes de lanzar la corrida sobre datos reales —
     "ya lo revisé una vez" no alcanza para algo que cuesta dinero real y no
     es trivialmente reversible.
4. **Idempotencia obligatoria antes de cualquier corrida real** (ver patrón
   de `message_processing_state`, `docs/DECISIONS.md`): una corrida
   interrumpida o repetida nunca debe reprocesar mensajes ya completados
   exitosamente. Verificar esto explícitamente antes de la corrida, no
   asumirlo. Es lo que evita pagar dos veces por el mismo mensaje y, con una
   suscripción, lo que permite repartir un backlog en varias ventanas de uso:
   un límite alcanzado corta la corrida y se reanuda después sin repetir
   trabajo.
5. **Después de la corrida**, registrar en `docs/DECISIONS.md` el consumo
   real observado (no solo el estimado) para calibrar estimaciones futuras:
   USD para API; llamadas, tokens y puntos de `/usage` para una suscripción;
   tiempo para un motor local. El informe de la propia corrida
   (`UsageAccumulator.report()`) ya lo da en la unidad correcta.
6. **Un motor no cambia de recurso sin avisar.** Cada corrida imprime el motor
   activo, qué consume y si los datos salen del equipo, y lo deja en
   `system_audit_log`. Cambiar `AI_PROVIDER`, un override por tier o
   `EMBEDDING_PROVIDER` es un cambio de costo y de destino de datos: se
   declara antes de correr. `claude-code` nunca debe recibir
   `ANTHROPIC_API_KEY` (pasaría a facturar por API en silencio); está
   cubierto por un test.
7. **Un motor nuevo se califica antes de usarlo en serio**: suite de
   contrato, smoke test y un subconjunto del banco de regresión contra la
   línea base, con umbrales fijados antes de correr
   (`plans/`, sección 6).
