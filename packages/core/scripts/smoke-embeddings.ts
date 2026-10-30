// Smoke test manual contra la API real de Voyage.
//
// Vive FUERA de `npm run verify` a propósito, igual que smoke-ai.ts:
// rules/ai-cost.md regla 1 prohíbe que un push o un PR generen gasto por
// sí solos. Se corre a mano con `npm run smoke:embeddings`, y su nombre no
// matchea el patrón de vitest, así que la suite nunca lo recoge.
//
// Todos los textos de acá son INVENTADOS (rules/agents-and-context.md):
// ninguno proviene de la conversación real. Cubre los casos borde que pide
// rules/ai-cost.md regla 3 antes de tocar el backlog: que la credencial
// sirva, que la dimensión configurada sea la que devuelve Voyage, que la
// atribución texto→vector no se desordene dentro de un lote, y que un
// texto desmedido falle como error de validación aislable y no tire abajo
// la corrida entera.

import "../src/shared/load-env.js";
import { config } from "../src/shared/config.js";
import { VoyageEmbeddingProvider } from "../src/infrastructure/ai/voyage-embedding-provider.js";
import { EmbeddingValidationError } from "../src/infrastructure/ai/provider.js";
import {
  buildEmbeddingChunkText,
  type ChunkMessage,
} from "../src/analysis/domain/embedding-chunking.js";

let fallos = 0;
function check(nombre: string, ok: boolean, detalle: string): void {
  console.log(`  ${ok ? "OK  " : "FALLA"} ${nombre} — ${detalle}`);
  if (!ok) fallos += 1;
}

let totalTokens = 0;
let llamadas = 0;
const onUsage = (u: { totalTokens: number }): void => {
  totalTokens += u.totalTokens;
  llamadas += 1;
};

const MODEL = config.embeddingModel ?? "";
const DIMS = config.embeddingDimensions ?? 0;

function coseno(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- Caso 1: lote normal, dimensión y orden ----------------------------
async function smokeLoteNormal(provider: VoyageEmbeddingProvider): Promise<void> {
  console.log("\n[1] Lote normal (dimensión, orden, credencial)");

  const textos = [
    "El martes llevo las entradas al teatro a las 9",
    "dale",
    "no puedo ese día, tengo turno con el dentista",
    "¿confirmamos entonces para el jueves?",
  ];

  const vectores = await provider.embedBatch(textos, {
    model: MODEL,
    dimensions: DIMS,
    inputType: "document",
    onUsage,
  });

  check(
    "devuelve un vector por texto",
    vectores.length === textos.length,
    `${vectores.length} vectores para ${textos.length} textos`
  );
  check(
    `cada vector tiene la dimensión configurada (${DIMS})`,
    vectores.every((v) => v.length === DIMS),
    `dimensiones observadas: ${[...new Set(vectores.map((v) => v.length))].join(", ")}`
  );
  check(
    "los vectores no son todos iguales (atribución texto→vector viva)",
    coseno(vectores[0] as number[], vectores[1] as number[]) < 0.999,
    `coseno(texto0, texto1) = ${coseno(vectores[0] as number[], vectores[1] as number[]).toFixed(4)}`
  );

  // Señal de calidad real, no solo de plomería: dos frases que significan
  // lo mismo deben quedar más cerca entre sí que de una frase de otro tema.
  const [relacionadas] = [
    await provider.embedBatch(
      [
        "no puedo el martes, tengo turno médico",
        "el martes me es imposible por una consulta con el doctor",
        "¿compraste pan para la cena?",
      ],
      { model: MODEL, dimensions: DIMS, inputType: "document", onUsage }
    ),
  ];
  const v = relacionadas as number[][];
  const simParafrasis = coseno(v[0] as number[], v[1] as number[]);
  const simDistinta = coseno(v[0] as number[], v[2] as number[]);
  check(
    "una paráfrasis queda más cerca que una frase de otro tema",
    simParafrasis > simDistinta,
    `paráfrasis=${simParafrasis.toFixed(4)} vs. otro tema=${simDistinta.toFixed(4)}`
  );
}

// --- Caso 2: query vs. document ----------------------------------------
async function smokeQueryVsDocument(provider: VoyageEmbeddingProvider): Promise<void> {
  console.log("\n[2] inputType query recupera el documento correcto");

  const documentos = [
    "El sábado la busco a las 10 de la mañana en tu casa",
    "Pagué la cuota del teatro, te paso el comprobante",
    "Se olvidó la campera en el auto",
  ];
  const docs = await provider.embedBatch(documentos, {
    model: MODEL,
    dimensions: DIMS,
    inputType: "document",
    onUsage,
  });
  const [consulta] = await provider.embedBatch(["¿cuándo se paga el teatro?"], {
    model: MODEL,
    dimensions: DIMS,
    inputType: "query",
    onUsage,
  });

  const similitudes = docs.map((d) => coseno(consulta as number[], d));
  const ganador = similitudes.indexOf(Math.max(...similitudes));
  check(
    "la consulta sobre el teatro recupera el documento del teatro",
    ganador === 1,
    `similitudes=[${similitudes.map((s) => s.toFixed(3)).join(", ")}], ganó el índice ${ganador}`
  );
}

// --- Caso 3: chunk real del pipeline -----------------------------------
async function smokeChunkDelPipeline(provider: VoyageEmbeddingProvider): Promise<void> {
  console.log("\n[3] El chunk que arma el pipeline se embebe sin romper");

  const ancla: ChunkMessage = {
    id: "00000000-0000-0000-0000-000000000003",
    participantId: "p1",
    content: "dale",
  };
  const contexto: ChunkMessage[] = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      participantId: "p2",
      content: "¿te queda bien el jueves a las 18?",
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      participantId: "p1",
      content: "yo salgo del trabajo 17:30",
    },
  ];

  const texto = buildEmbeddingChunkText(ancla, contexto);
  console.log(`  (chunk inventado, ${texto.length} caracteres)`);

  const [vector] = await provider.embedBatch([texto], {
    model: MODEL,
    dimensions: DIMS,
    inputType: "document",
    onUsage,
  });
  check(
    "el chunk con ventana de contexto se embebe con la dimensión correcta",
    vector?.length === DIMS,
    `dimensión ${vector?.length ?? "ninguna"}`
  );

  // Lo que justifica la ventana de contexto: "dale" solo es ambiguo; con
  // el hilo delante debería acercarse a una consulta sobre coordinar día.
  const [soloAncla] = await provider.embedBatch(["dale"], {
    model: MODEL,
    dimensions: DIMS,
    inputType: "document",
    onUsage,
  });
  const [consulta] = await provider.embedBatch(["¿acordaron encontrarse el jueves?"], {
    model: MODEL,
    dimensions: DIMS,
    inputType: "query",
    onUsage,
  });
  const conContexto = coseno(consulta as number[], vector as number[]);
  const sinContexto = coseno(consulta as number[], soloAncla as number[]);
  check(
    "la ventana de contexto mejora la recuperación de un mensaje ambiguo",
    conContexto > sinContexto,
    `con contexto=${conContexto.toFixed(4)} vs. solo "dale"=${sinContexto.toFixed(4)}`
  );
}

// --- Caso 4: texto desmedido -------------------------------------------
async function smokeTextoLargo(provider: VoyageEmbeddingProvider): Promise<void> {
  console.log("\n[4] Texto que excede el límite del modelo");

  // Voyage NO rechaza esto: lo trunca en silencio y devuelve un vector con
  // pinta de válido (comprobado contra la API real — un texto de ~560k
  // caracteres volvió como 32k tokens facturados, sin error). Por eso el
  // tope lo impone el provider ANTES de salir a la red, y falla como
  // EmbeddingValidationError: aislable por mensaje (SI-034), no sistémico.
  //
  // No se manda a la API a propósito: el corte es local, así que este caso
  // no gasta tokens.
  const enorme = "coordinemos el fin de semana ".repeat(20000);

  try {
    await provider.embedBatch([enorme], {
      model: MODEL,
      dimensions: DIMS,
      inputType: "document",
      onUsage,
    });
    check(
      "un texto desmedido no pasa silenciosamente",
      false,
      "se embebió sin error — el tope local no se aplicó y Voyage lo habría truncado"
    );
  } catch (err) {
    check(
      "un texto desmedido falla como error de validación aislable, sin salir a la red",
      err instanceof EmbeddingValidationError,
      err instanceof Error ? `${err.constructor.name}: ${err.message.slice(0, 120)}` : String(err)
    );
  }
}

async function main(): Promise<void> {
  console.log("Smoke test contra la API real de Voyage. Textos inventados, nunca datos de la conversación.");

  if (!MODEL || !DIMS) {
    throw new Error("EMBEDDING_MODEL / EMBEDDING_DIMENSIONS no están definidos. Ver .env.example.");
  }
  console.log(`Modelo: ${MODEL} @ ${DIMS} dimensiones`);

  const provider = new VoyageEmbeddingProvider();

  await smokeLoteNormal(provider);
  await smokeQueryVsDocument(provider);
  await smokeChunkDelPipeline(provider);
  await smokeTextoLargo(provider);

  console.log("\n--- Consumo real de esta corrida ---");
  console.log(JSON.stringify({ llamadas, totalTokens }, null, 2));
  console.log(
    fallos === 0 ? "\nTodas las comprobaciones pasaron." : `\n${fallos} comprobación(es) fallaron.`
  );
  process.exitCode = fallos === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
