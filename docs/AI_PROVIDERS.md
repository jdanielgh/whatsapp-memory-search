# Proveedores de IA

El dominio nunca llama a un modelo directamente: depende de dos interfaces y
un **proveedor** concreto se elige por configuración. Esta guía explica qué
motores hay, cómo elegir uno y cómo agregar otro.

## Motores disponibles

| Nombre | Se registra como | Consume | Los datos salen del equipo | Estado |
|---|---|---|---|---|
| `anthropic-api` | completions | saldo de API (dinero) | sí | disponible (opt-in) |
| `claude-code` | completions | cuota de tu suscripción de Claude Code | sí | disponible, **default** |
| `voyage` | embeddings | cuota gratuita de Voyage; dinero si se excede | sí | disponible, **default actual** |
| `openai-compatible` | completions | depende (local: tiempo de máquina) | no si es local | planificado |
| embeddings locales | embeddings | tiempo de máquina | no | planificado |

Qué hace cada etapa con IA: **completions** ejecuta Entity Detection, Event
Detection, Intent Detection y la generación de respuestas; **embeddings**
alimenta la búsqueda semántica.

## Elegir el motor

Todo se configura con variables de entorno (se leen solo en
`packages/core/src/shared/config.ts`):

| Variable | Qué hace | Default |
|---|---|---|
| `AI_PROVIDER` | motor de completions | `claude-code` |
| `AI_PROVIDER_CHEAP` / `AI_PROVIDER_DEFAULT` | motor distinto para un tier | el de `AI_PROVIDER` |
| `EMBEDDING_PROVIDER` | motor de embeddings | `voyage` |

Un nombre desconocido falla al arrancar y lista los disponibles. Los dos
tiers son `cheap` (extracción de alto volumen, p. ej. entidades) y `default`
(interpretación donde un error pesa más, p. ej. eventos). Con un motor
distinto por tier, un `RoutingProvider` delega según el tier sin que los
casos de uso se enteren.

```bash
# Solo la suscripción de Claude Code, sin saldo de API
AI_PROVIDER=claude-code

# Mezcla: un motor para cada tier
AI_PROVIDER_CHEAP=anthropic-api
AI_PROVIDER_DEFAULT=claude-code
```

Cada corrida imprime por `stderr` qué motor ejecuta, qué consume y si los
datos salen del equipo, y deja ese dato en `system_audit_log` junto con el
perfil de dominio:

```
IA: claude-code · consume: cuota de suscripción · datos salen del equipo: sí · esquema forzado por el motor
```

Elegir un motor es elegir a dónde van los datos (`rules/security-privacy.md`
regla 8) y qué recurso se gasta (`rules/ai-cost.md`).

## `anthropic-api`

Usa el SDK oficial con `ANTHROPIC_API_KEY`. La salida estructurada se fuerza
con tool-use. Los modelos de cada tier salen de `AI_MODEL_CHEAP` y
`AI_MODEL_DEFAULT`. Es el único motor que se convierte a USD en el informe de
consumo.

## `claude-code` (suscripción)

Ejecuta Claude Code en modo no interactivo (`claude -p`) y por lo tanto gasta
la cuota de tu suscripción, no saldo de API.

**Requisitos:** Claude Code instalado y con sesión iniciada (`claude login`).
Como es el motor por defecto, cada CLI lo comprueba al arrancar con
`claude auth status`, que no consume cuota: si falta la sesión o `claude`
está autenticado con una clave de API (gastaría saldo), falla **antes** de la
primera llamada con un mensaje que dice cómo resolverlo o cambiar a
`AI_PROVIDER=anthropic-api`.

| Variable | Qué hace | Default |
|---|---|---|
| `CLAUDE_CODE_MODEL_CHEAP` | modelo del tier `cheap` | `haiku` |
| `CLAUDE_CODE_MODEL_DEFAULT` | modelo del tier `default` | `sonnet` |
| `CLAUDE_CLI_PATH` | ruta de `claude.exe` si no está en el `PATH` | se busca solo |
| `CLAUDE_CODE_TIMEOUT_MS` | tiempo máximo por llamada | `300000` |

Lo que conviene saber:

- **No usa tu `ANTHROPIC_API_KEY`.** El proveedor la quita del entorno del
  subproceso; si no, `claude` facturaría por API en silencio. Hay un test
  que lo comprueba.
- **Los alias `haiku`/`sonnet` apuntan al modelo más reciente y cambian con
  el tiempo.** Para resultados reproducibles fija un ID de modelo explícito.
  El modelo real que atendió cada llamada es el que se registra.
- **La cuota se comparte con tu uso interactivo.** Una corrida grande puede
  dejarte sin ella. Mide antes con una corrida acotada (`--limit`) y compara
  `/usage` antes y después. Un límite alcanzado corta la corrida con un
  error claro, y como el procesamiento es idempotente se reanuda más tarde sin
  repetir trabajo.
- **Es más lento que la API:** unos 10 s por llamada, en secuencia (Event
  Detection necesita procesar las ventanas en orden). Un corpus de miles de
  mensajes son del orden de dos horas.
- **Razonamiento:** `thinking: "disabled"` se traduce a `--effort low`. En
  Haiku el razonamiento no se puede eliminar del todo.
- **Respuestas que no cumplen el esquema** se devuelven como texto y las
  rechaza el parser por mensaje; los errores del motor (sin sesión, límite de
  uso, proceso, tiempo agotado) se lanzan y cortan la corrida.
- **No genera embeddings.** Usa `EMBEDDING_PROVIDER`.
- En Windows `claude` es un acceso directo `claude.cmd`; el proveedor lanza
  `claude.exe` directamente.

## `voyage` (embeddings)

Usa la API de Voyage con `VOYAGE_API_KEY`, `EMBEDDING_MODEL` y
`EMBEDDING_DIMENSIONS` (hoy `voyage-3-large` a 1024). "Gratis" significa
dentro de la cuota gratuita: sin un método de pago registrado la cuenta queda
limitada a pocas solicitudes por minuto, lo que vuelve inviable un corpus
grande. Cambiar de modelo de embeddings no pisa los vectores anteriores
(conviven por `model` y `dims`); si cambia la dimensión hace falta una
migración.

## El contrato de un proveedor

Un proveedor de completions implementa `DescribedAIProvider`
(`infrastructure/ai/provider.ts`):

```ts
interface DescribedAIProvider {
  readonly info: ProviderInfo;                       // nombre + capacidades
  complete(prompt: string, opts?: CompletionOptions): Promise<string>;
  embed(text: string, opts?: EmbeddingOptions): Promise<number[]>;
}
```

Un proveedor de embeddings implementa `DescribedEmbeddingProvider` con
`embedBatch(texts, { model, dimensions, inputType })`.

**Capacidades que se declaran** (`info.capabilities`):

| Campo | Valores | Para qué |
|---|---|---|
| `structuredOutput` | `native` / `prompt` | si el motor fuerza el esquema o se confía en el parser |
| `usage` | `exact` / `estimated` / `none` | si informa tokens |
| `billing` | `api` / `subscription` / `local` | qué recurso consume |
| `dataLeavesMachine` | `true` / `false` | a dónde van los datos |
| `supportsThinking` | `true` / `false` | si respeta `thinking` |

**La frontera de errores es la regla más importante** y la comparten todos los
motores:

- Un fallo del **motor** (credencial, sin cuota, red, proceso, tiempo agotado,
  límite de uso) se **lanza**. Corta la corrida: si se tratara como fallo de
  un mensaje, un motor sin cuota generaría miles de fallos silenciosos.
- Una respuesta **mal formada** del modelo se **devuelve como texto**. La
  rechaza el parser por mensaje (SI-034) y el mensaje queda reintentable.
- Una respuesta **cortada** por el tope de tokens lanza
  `ModelResponseTruncatedError`: se distingue de un error de formato porque
  la acción correctiva es otra.

**Uso y costo:** si el motor informa tokens, llama a `opts.onUsage` con el
modelo real que atendió la llamada y `billing`. Un fallo del contador nunca
debe tirar una llamada ya consumida. Solo `billing: "api"` se convierte a USD.

## Cómo agregar un proveedor

1. **Escribe la clase** en `packages/core/src/infrastructure/ai/`
   implementando `DescribedAIProvider` (o `DescribedEmbeddingProvider`) y
   declarando `info`. Si lanza un proceso o hace HTTP, **inyecta** el lanzador
   o el `fetch` para poder probarlo con un fake.

   ```ts
   export class MiProveedor implements DescribedAIProvider {
     readonly info: ProviderInfo = {
       name: "mi-proveedor",
       capabilities: {
         structuredOutput: "prompt",
         usage: "estimated",
         billing: "local",
         dataLeavesMachine: false,
         supportsThinking: false,
       },
     };
     async complete(prompt: string, opts: CompletionOptions = {}) { /* ... */ }
     async embed(): Promise<number[]> { throw new Error("no soportado"); }
   }
   ```

2. **Regístrala** en `factory.ts`:

   ```ts
   aiProviderRegistry.register("mi-proveedor", () => new MiProveedor());
   ```

3. **Configuración**: variables nuevas solo en `shared/config.ts` (único lector
   de `process.env`) y documentadas en `.env.example`. Los nombres de modelo
   son propios de cada motor: no reutilices `AI_MODEL_*`, o dos motores
   convivirían con el mismo nombre para cosas distintas.

4. **Tests** (sin llamar al motor real, `rules/ai-cost.md` regla 1). Como
   mínimo:
   - arma bien la invocación (modelo según tier, esquema solo si se pide);
   - devuelve el texto de la respuesta, y una respuesta sin esquema cumplido
     se **devuelve** en vez de lanzar;
   - un fallo del motor **lanza** con un mensaje que dice qué hacer;
   - el truncamiento lanza `ModelResponseTruncatedError`;
   - informa el modelo real y `billing` en `onUsage`, y un `onUsage` que falla
     no tira la llamada;
   - no filtra credenciales que cambiarían el recurso consumido;
   - usa fixtures **reales** capturados con texto inventado cuando existan
     (`infrastructure/ai/fixtures/`), no sobres escritos a mano.

   Una suite de contrato compartida entre motores está planificada; hasta entonces esta lista es el contrato.

5. **Califícalo antes de usarlo en serio**: `npm run verify`, el smoke test
   (`AI_PROVIDER=mi-proveedor npm run smoke:ai`, mensajes inventados) y un
   subconjunto del banco de regresión comparado con la línea base, con
   umbrales fijados **antes** de correr.

6. **Documéntalo** en la tabla de este archivo y declara en `info` si los
   datos salen del equipo.

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `Proveedor de completions desconocido: "x". Disponibles: …` | `AI_PROVIDER` mal escrito; usa uno de los listados |
| `Failed to authenticate` / mensaje con `claude login` | la sesión de Claude Code expiró; inicia sesión en una terminal |
| Error de límite de uso de la suscripción | espera a que se reinicie la cuota y vuelve a lanzar el mismo comando; reanuda sin repetir trabajo |
| `No se pudo lanzar Claude Code` | instala Claude Code o define `CLAUDE_CLI_PATH` |
| El informe dice "sin costo en USD" | es lo correcto con suscripción o motor local: se reporta en llamadas y tokens |
| `Claude Code no devolvió JSON` | el CLI falló al arrancar; revisa el `stderr` que acompaña al mensaje |
