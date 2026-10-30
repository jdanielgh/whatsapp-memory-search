# WhatsApp Memory Search

**Español** · [English](README.en.md)

> Archive a WhatsApp conversation as immutable evidence, index it, and ask
> questions about it — every answer cites the messages that support it.

Asistente que archiva una conversación de WhatsApp en PostgreSQL, la
procesa con IA (entidades, eventos, temas) y la indexa para búsqueda
literal y semántica. Responde preguntas en lenguaje natural **citando
siempre los mensajes que sostienen la respuesta**, y dice que no puede
responder cuando la evidencia no alcanza.

> **Idiomas de la documentación.** La documentación principal está en
> español ([`docs/`](docs/README.md)). La versión completa en inglés de los
> documentos de diseño está en [`docs/en/`](docs/en/README.md) y en
> [`README.en.md`](README.en.md). Los comentarios del código están en español.

## Qué lo distingue

- **La conversación es evidencia inmutable.** `conversations`,
  `participants`, `messages` y `attachments` nunca se modifican: el rol de
  Postgres que usa la app ni siquiera tiene permiso de `UPDATE`/`DELETE`
  sobre ellas. Todo lo demás (entidades, eventos, resúmenes, embeddings) es
  conocimiento derivado y regenerable.
- **Respuestas verificables.** El modelo no devuelve texto libre sino
  afirmaciones con los índices de la evidencia que las respalda. Una
  validación determinista, del lado del sistema, marca como no respaldada
  cualquier afirmación que cite evidencia inexistente.
- **Idempotente y con el gasto bajo control.** Cada etapa se puede
  reejecutar sin repetir trabajo (ni pagarlo dos veces). Las corridas con
  IA real son opt-in, reportan su costo y nunca corren en tests ni en CI.
- **IA desacoplada.** El dominio depende de una abstracción (`AIProvider`,
  `EmbeddingBatchProvider`), nunca de un SDK; los tests usan fakes
  deterministas.
- **Genérico por diseño.** Las categorías de tema, las dimensiones de
  análisis y el contexto de los prompts salen de un **perfil de dominio**
  configurable (ver más abajo).

## Cómo funciona

```
export de WhatsApp ──► Archivo (evidencia inmutable)
                           │
        Metadata ─► Entidades ─► Eventos + Cases ─► Embeddings
        (sin IA)    (IA barata)   (IA, por ventanas)  (pgvector)
                           │
   pregunta ─► intent ─► búsqueda (literal / fecha / cronología /
                          tema / estadísticas / semántica)
                           │
                  respuesta + afirmaciones + evidencia citada
```

[`docs/VISUAL_GUIDE.md`](docs/VISUAL_GUIDE.md) recorre el sistema completo
en diagramas: arquitectura, pipelines, estados de un mensaje, agregados y
cómo se verifica que una respuesta se sostenga en la evidencia. Para el
detalle de producto, `docs/VISION.md`; para las decisiones técnicas,
`docs/ARCHITECTURE.md`.

## Stack

- Node.js / TypeScript (monorepo con npm workspaces)
- PostgreSQL + pgvector (evidencia + búsqueda semántica, índice HNSW)
- Drizzle ORM
- IA intercambiable (ver [`docs/AI_PROVIDERS.md`](docs/AI_PROVIDERS.md)):
  la API de Anthropic o **Claude Code por suscripción** (sin saldo de API)
  para clasificación y respuestas, y Voyage AI para embeddings (Anthropic
  no expone endpoint de embeddings). Se elige por configuración.

## Inicio rápido

Requiere Node.js 20+ y Docker.

```bash
cp .env.example .env    # contraseñas; ANTHROPIC_API_KEY solo si usas AI_PROVIDER=anthropic-api
npm install
npm run db:up           # levanta Postgres + pgvector (docker compose)
npm run db:migrate      # aplica el esquema y los permisos del rol de runtime
npm run verify          # typecheck + unit + integration (no usa la API)
```

`npm run test:integration` corre contra una base de datos de test efímera,
derivada automáticamente de las credenciales de `.env`. `npm run verify`
corre las tres capas y también corre en CI (`.github/workflows/verify.yml`).

### Uso

```bash
npm run sync -- --file ./_chat.txt --date-format dmy --timezone eu-cet-cest
npm run process:metadata
npm run process:entities -- --limit 100     # usa IA; acotar para validar
npm run process:events   -- --limit 100     # usa IA
npm run process:embeddings                  # usa Voyage
npm run ask -- "¿Cuándo se acordó el cambio de horario?"
```

| Comando | Qué hace |
|---|---|
| `npm run sync` | Importa (primera vez) o sincroniza (siguientes) un export de WhatsApp |
| `npm run process:metadata` | Idioma, emojis y menciones. Determinista, sin IA |
| `npm run process:entities` | Entity Detection. **Usa IA** |
| `npm run process:events` | Event Detection + Case Resolution. **Usa IA** |
| `npm run process:embeddings` | Embeddings para búsqueda semántica. **Usa Voyage** |
| `npm run ask -- "<pregunta>"` | Responde con evidencia citada. **Usa IA** |
| `npm run smoke:ai` | Smoke test manual contra el motor configurado, con datos inventados |
| `npm run verify` | typecheck + unit + integration (nunca usa un motor real) |

Los comandos marcados consumen el recurso del motor configurado (saldo de
API o cuota de suscripción), imprimen al empezar qué motor usan y si los
datos salen del equipo, y reportan al terminar el consumo en la unidad
correcta. Ninguno imprime contenido de mensajes, salvo `ask`: ahí la
evidencia es el punto, porque una respuesta sin los mensajes que la
sustentan no sería verificable.

## Motores de IA

La IA se elige por configuración, sin tocar el código:

```bash
AI_PROVIDER=claude-code     # default: tu suscripción de Claude Code (sin saldo de API)
AI_PROVIDER=anthropic-api   # la API de Anthropic (saldo; requiere ANTHROPIC_API_KEY)
```

`claude-code` requiere Claude Code instalado y con sesión iniciada (si falta,
cada comando falla al arrancar con instrucciones, sin gastar nada) y nunca
usa tu `ANTHROPIC_API_KEY`. También se puede usar un motor distinto por tier
(`AI_PROVIDER_CHEAP`, `AI_PROVIDER_DEFAULT`) y elegir el de embeddings
(`EMBEDDING_PROVIDER`). Qué cuesta, a dónde van los datos y cómo agregar tu
propio motor: [`docs/AI_PROVIDERS.md`](docs/AI_PROVIDERS.md).

## Perfiles de dominio

Lo que cambia entre un uso y otro (categorías de tema, dimensiones de
análisis, el contexto que se inyecta en los prompts, los plazos para
agrupar eventos en un mismo tema) vive en un **perfil de dominio**, no en
el código. Sin configuración se usa el perfil genérico incluido.

Para uno propio, copiar [`profiles/example.json`](profiles/example.json) a
`profiles/local/` (ignorado por git), ajustarlo y apuntar a él:

```bash
DOMAIN_PROFILE_PATH=profiles/local/mi-perfil.json
```

Un perfil inválido aborta con un error claro; nunca cae en silencio al
genérico. El perfil activo queda registrado en `prompt_version` de cada
análisis, así que se puede saber qué interpretación produjo cada uno.

## Costo de IA

Dos niveles de modelo según la tarea (`tier: "cheap" | "default"`):

- **`cheap` (Haiku)**: extracción estructurada de alto volumen y baja
  ambigüedad (Entity Detection).
- **`default` (Sonnet)**: clasificación donde un error pesa más que el
  costo (Event Detection).

Los mensajes de chat son cortos, así que el costo por llamada lo domina el
prompt fijo. Por eso ambas etapas **agrupan varios mensajes por llamada**
(lotes de 25 para entidades, ventanas de 20 mensajes consecutivos para
eventos). Órdenes de magnitud medidos sobre un corpus real, por cada 1.000
mensajes:

| Etapa | Modelo | Costo aprox. |
|---|---|---|
| Entity Detection | Haiku 4.5 | ~$0,28 |
| Event Detection | Sonnet 5 | ~$0,65 |
| Embeddings | Voyage `voyage-3-large` | $0 dentro del tier gratuito |

Los costos de la tabla son de la API de Anthropic. Con `claude-code` no hay
cobro por token: el consumo es cuota de la suscripción, que se comparte con
tu uso interactivo. Medido sobre un plan concreto, procesar un corpus de
miles de mensajes ocupó del orden de una ventana de sesión de 5 horas (la
cifra depende de tu plan), a unos 10 s por llamada.

El procesamiento corre una vez sobre el backlog y luego en incrementos
chicos al sincronizar. Cada pregunta al asistente cuesta del orden de
céntimos con la API.

## Estado del proyecto

- ✅ **01 Foundations**: scaffolding, esquema, abstracción de IA.
- ✅ **02 Archive & Ingestion**: importar/sincronizar un export de WhatsApp.
- ✅ **03 Processing & Knowledge**: metadata, entidades, eventos y Cases.
- ✅ **04 Search & Evidence**: búsqueda literal, por fecha, cronología,
  Cases y estadísticas.
- ✅ **05 Embeddings & Semantic Search**.
- ✅ **06 Agent & Q&A**: respuestas con evidencia y validación
  determinista de las citas.
- ✅ **Perfiles de dominio**.
- 🔄 **Motores de IA intercambiables**:
  fábrica, API de Anthropic y Claude Code por suscripción disponibles;
  modelos locales (`openai-compatible`) y embeddings locales planificados.
- ⏳ Insights, resúmenes, recordatorios, borradores, reprocesamiento y
  la ingesta continua vía Cloud API: planificados.

## Datos y privacidad

Un historial de chat puede contener datos personales de terceros reales,
menores incluidos. Por eso el proyecto nunca incluye conversaciones reales (los
fixtures son inventados), nunca imprime el historial completo, y exige
cifrar los backups que salgan del equipo local. Ver
`.claude/rules/security-privacy.md` y `docs/SECURITY.md`.

El proyecto se desarrolla con Claude Code; su configuración (reglas,
skills y agentes) vive en `.claude/`.

## Licencia

[MIT](LICENSE) © 2026 Jesus Daniel Gomez Hernandez
