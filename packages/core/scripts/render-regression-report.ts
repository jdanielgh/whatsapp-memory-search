// Convierte el JSONL de la regresión (scripts/regression-100-questions.ts)
// en un HTML navegable, para poder revisar las 100 respuestas sin leer
// JSON crudo.
//
// Entrada y salida viven en backups/, ignorado por git: el reporte
// contiene evidencia REAL de la conversación (rules/security-privacy.md),
// así que nunca entra al repo ni se sube a ningún lado. Este script solo
// lee un archivo local y escribe otro al lado — no toca la base de datos
// ni llama a ninguna API.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPO_ROOT } from "../src/shared/repo-paths.js";

const INPUT = path.join(REPO_ROOT, "backups", "regression-100-questions.jsonl");
const OUTPUT = path.join(REPO_ROOT, "backups", "regression-100-questions.html");
/** Costo real de la corrida, cuando el JSONL no lo trae por pregunta. Opcional. */
const SUMMARY = path.join(REPO_ROOT, "backups", "regression-100-questions.run-summary.json");

interface RecordedAnswer {
  n: number;
  question: string;
  intent: string;
  answer: string;
  verified: boolean;
  evidenceTruncated: boolean;
  contextItems: number;
  claims: Array<{ statement: string; supported: boolean; evidenceIds: string[] }>;
  evidence: Array<{
    index: number;
    sourceType: string;
    sourceId: string;
    /** Ausente en corridas previas al 2026-08-04. */
    sentAt?: string;
    text: string;
    windowMessages?: Array<{ messageId: string; sentAt: string }>;
  }>;
  aiCalls: number;
  /** Presente solo en corridas posteriores al 2026-08-04; antes solo había total global. */
  usage?: Array<{
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number | null;
  }>;
  elapsedMs: number;
  error?: string;
}

interface RunSummary {
  perQuestionDisponible: boolean;
  corridas: Array<{ descripcion: string; preguntas: number; usd: number; resultado: string }>;
  totalUsd: number;
  estimadoPrevio?: number;
  notaEstimacion?: string;
}

/**
 * Fecha legible para volver al historial original y ubicar el mensaje.
 * Se muestra en hora local del navegador y se deja el ISO en el `title`,
 * porque para buscar en WhatsApp lo que sirve es el día y la hora, no el
 * UUID.
 */
function fecha(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dia = d.toLocaleDateString("es", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const hora = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${dia} ${hora}</time>`;
}

/** Costo de una pregunta, o null si esa corrida no lo registró. */
function usdOf(r: RecordedAnswer): number | null {
  if (!r.usage?.length) return null;
  if (r.usage.some((u) => u.estimatedUsd === null)) return null;
  return r.usage.reduce((s, u) => s + (u.estimatedUsd ?? 0), 0);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Etiqueta de por qué una respuesta no quedó verificada — el dato más útil al revisar. */
function statusOf(r: RecordedAnswer): { label: string; cls: string } {
  if (r.error) return { label: "error", cls: "err" };
  if (r.verified) return { label: "verificada", cls: "ok" };
  if (r.contextItems === 0) return { label: "sin evidencia", cls: "none" };
  if (r.claims.some((c) => !c.supported)) {
    return { label: "cita índice inexistente", cls: "bad" };
  }
  return { label: "el modelo dijo: evidencia insuficiente", cls: "warn" };
}

async function main(): Promise<void> {
  const raw = await readFile(INPUT, "utf8");
  const rows = raw
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RecordedAnswer);

  // Una corrida reintentada deja varias filas por pregunta: vale la última.
  const latest = new Map<number, RecordedAnswer>();
  for (const r of rows) latest.set(r.n, r);
  const all = [...latest.values()].sort((a, b) => a.n - b.n);

  const stats = {
    total: all.length,
    verified: all.filter((r) => r.verified).length,
    noEvidence: all.filter((r) => !r.error && r.contextItems === 0).length,
    unsupported: all.filter(
      (r) => !r.error && r.contextItems > 0 && r.claims.some((c) => !c.supported)
    ).length,
    insufficient: all.filter(
      (r) =>
        !r.error &&
        !r.verified &&
        r.contextItems > 0 &&
        !r.claims.some((c) => !c.supported)
    ).length,
    errors: all.filter((r) => r.error).length,
  };

  const byIntent = new Map<string, number>();
  for (const r of all) byIntent.set(r.intent, (byIntent.get(r.intent) ?? 0) + 1);

  let summary: RunSummary | null = null;
  try {
    summary = JSON.parse(await readFile(SUMMARY, "utf8")) as RunSummary;
  } catch {
    // Sin resumen de corrida: el bloque de costo simplemente no se muestra.
  }

  const conCosto = all.filter((r) => usdOf(r) !== null);
  const totalPorPregunta = conCosto.reduce((s, r) => s + (usdOf(r) ?? 0), 0);

  // Costo por intent: solo tiene sentido si el JSONL trae el dato por
  // pregunta. Si no, no se inventa un prorrateo.
  const costByIntent = new Map<string, { n: number; usd: number }>();
  for (const r of conCosto) {
    const cur = costByIntent.get(r.intent) ?? { n: 0, usd: 0 };
    cur.n += 1;
    cur.usd += usdOf(r) ?? 0;
    costByIntent.set(r.intent, cur);
  }

  const costSection = (() => {
    if (conCosto.length > 0) {
      const filas = [...costByIntent]
        .sort((a, b) => b[1].usd - a[1].usd)
        .map(
          ([i, s]) =>
            `<tr><td><code>${escapeHtml(i)}</code></td><td>${s.n}</td><td>$${s.usd.toFixed(
              4
            )}</td><td>$${(s.usd / s.n).toFixed(4)}</td></tr>`
        )
        .join("");
      return `<h2>Costo</h2>
      <p class="sub">Medido por pregunta. Total de las ${conCosto.length} con dato: <strong>$${totalPorPregunta.toFixed(
        4
      )}</strong> · media $${(totalPorPregunta / conCosto.length).toFixed(4)}.</p>
      <table><thead><tr><th>intent</th><th>preguntas</th><th>total</th><th>media</th></tr></thead><tbody>${filas}</tbody></table>`;
    }
    if (!summary) return "";
    const filas = summary.corridas
      .map(
        (c) =>
          `<tr><td>${escapeHtml(c.descripcion)}</td><td>${c.preguntas}</td><td>$${c.usd.toFixed(
            4
          )}</td><td class="muted">${escapeHtml(c.resultado)}</td></tr>`
      )
      .join("");
    return `<h2>Costo real de la regresión</h2>
    <p class="sub"><strong>Esta corrida no registró el costo por pregunta</strong> — el script solo acumulaba el total.
    Se corrigió después, así que las próximas corridas sí lo tendrán individualmente. Prorratear el total daría un
    número que parece medido y no lo es: una pregunta con 40 ítems de evidencia cuesta bastante más que una de 1.</p>
    <table><thead><tr><th>corrida</th><th>preguntas</th><th>USD</th><th>resultado</th></tr></thead><tbody>${filas}
    <tr class="tot"><td><strong>Total</strong></td><td></td><td><strong>$${summary.totalUsd.toFixed(
      4
    )}</strong></td><td></td></tr></tbody></table>
    ${
      summary.notaEstimacion
        ? `<p class="sub">Estimado previo: $${summary.estimadoPrevio?.toFixed(
            2
          )}. ${escapeHtml(summary.notaEstimacion)}</p>`
        : ""
    }`;
  })();

  const cards = all
    .map((r) => {
      const st = statusOf(r);
      // Rango temporal que cubre la evidencia de esta pregunta: es lo
      // primero que se necesita para saber a qué parte del historial ir.
      const fechas = r.evidence
        .flatMap((e) => [e.sentAt, ...(e.windowMessages ?? []).map((m) => m.sentAt)])
        .filter((f): f is string => Boolean(f))
        .sort();
      const rango =
        fechas.length > 0
          ? `<span class="range">${fecha(fechas[0])}${
              fechas[fechas.length - 1] !== fechas[0]
                ? ` → ${fecha(fechas[fechas.length - 1])}`
                : ""
            }</span>`
          : "";
      const claims = r.claims.length
        ? `<h4>Afirmaciones (${r.claims.length})</h4><ul class="claims">${r.claims
            .map(
              (c) =>
                `<li class="${c.supported ? "sup" : "unsup"}"><span class="mark">${
                  c.supported ? "✓" : "✗"
                }</span> ${escapeHtml(c.statement)} <span class="ids">${
                  c.evidenceIds.length
                } ref.</span></li>`
            )
            .join("")}</ul>`
        : "";

      const evidence = r.evidence.length
        ? `<details><summary>Evidencia entregada al modelo (${r.evidence.length} ítems)</summary><ol class="ev">${r.evidence
            .map((e) => {
              // Una ventana de Semantic Search agrupa varios mensajes con
              // fechas distintas: mostrar solo la del ancla dejaría al
              // resto imposible de ubicar en el historial.
              const ventana =
                e.windowMessages && e.windowMessages.length > 1
                  ? `<div class="win">Ventana de ${e.windowMessages.length} mensajes: ${e.windowMessages
                      .map((m) => fecha(m.sentAt))
                      .join(" · ")}</div>`
                  : "";
              return `<li><span class="type">${escapeHtml(e.sourceType)}</span>
                <span class="date">${fecha(e.sentAt)}</span>
                ${ventana}<pre>${escapeHtml(e.text)}</pre></li>`;
            })
            .join("")}</ol></details>`
        : "";

      return `<article class="card" data-status="${st.cls}" data-intent="${escapeHtml(r.intent)}">
  <header>
    <span class="num">#${r.n}</span>
    <span class="badge ${st.cls}">${st.label}</span>
    <span class="intent">${escapeHtml(r.intent)}</span>
    <span class="meta">${r.contextItems} ítems · ${(r.elapsedMs / 1000).toFixed(1)}s${
      usdOf(r) !== null ? ` · $${(usdOf(r) ?? 0).toFixed(4)}` : ""
    }</span>
  </header>
  <h3>${escapeHtml(r.question)}</h3>
  ${rango ? `<p class="rangeline">Evidencia entre ${rango}</p>` : ""}
  ${r.error ? `<p class="errbox">${escapeHtml(r.error)}</p>` : `<p class="answer">${escapeHtml(r.answer)}</p>`}
  ${claims}
  ${evidence}
</article>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Regresión de 100 preguntas — Conversation Memory Assistant</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#e3e3e3; --card:#fafafa; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2c2f36; --card:#1d2025; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  .sub { color:var(--muted); margin:0 0 2rem; }
  .warnbox { border:1px solid #d9a441; background:#d9a4411a; padding:.75rem 1rem;
             border-radius:8px; margin-bottom:2rem; font-size:.9rem; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
           gap:.75rem; margin-bottom:1.5rem; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:.75rem; }
  .stat b { display:block; font-size:1.6rem; line-height:1.2; }
  .stat span { color:var(--muted); font-size:.8rem; }
  .filters { display:flex; flex-wrap:wrap; gap:.5rem; margin-bottom:1.5rem; }
  .filters button { border:1px solid var(--line); background:var(--card); color:var(--fg);
                    padding:.4rem .8rem; border-radius:999px; cursor:pointer; font-size:.85rem; }
  .filters button[aria-pressed="true"] { background:var(--fg); color:var(--bg); }
  .card { border:1px solid var(--line); border-radius:10px; padding:1rem 1.25rem;
          margin-bottom:1rem; background:var(--card); }
  .card header { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center;
                 margin-bottom:.5rem; font-size:.8rem; }
  .num { font-weight:700; color:var(--muted); }
  .badge { padding:.15rem .55rem; border-radius:999px; font-size:.75rem; font-weight:600; }
  .badge.ok   { background:#1f7a3f22; color:#1f7a3f; }
  .badge.warn { background:#b4770022; color:#b47700; }
  .badge.none { background:#5f5f5f22; color:var(--muted); }
  .badge.bad  { background:#b0202022; color:#b02020; }
  .badge.err  { background:#b0202033; color:#b02020; }
  @media (prefers-color-scheme: dark) {
    .badge.ok{color:#5fd08a}.badge.warn{color:#e0a740}.badge.bad,.badge.err{color:#f08080}
  }
  .intent { font-family:ui-monospace,monospace; color:var(--muted); }
  .meta { margin-left:auto; color:var(--muted); }
  h3 { font-size:1.02rem; margin:.25rem 0 .6rem; }
  .answer { margin:.4rem 0 .8rem; white-space:pre-wrap; }
  .errbox { color:#b02020; font-family:ui-monospace,monospace; font-size:.85rem; }
  h4 { font-size:.8rem; text-transform:uppercase; letter-spacing:.04em;
       color:var(--muted); margin:1rem 0 .4rem; }
  ul.claims { list-style:none; padding:0; margin:0; }
  ul.claims li { padding:.35rem 0; border-top:1px solid var(--line); font-size:.92rem; }
  .mark { font-weight:700; }
  li.sup .mark { color:#1f7a3f; } li.unsup .mark { color:#b02020; }
  .ids { color:var(--muted); font-size:.8rem; }
  details { margin-top:.8rem; }
  summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
  ol.ev { padding-left:1.2rem; }
  ol.ev li { margin:.5rem 0; }
  .type { font-size:.7rem; text-transform:uppercase; color:var(--muted); letter-spacing:.05em; }
  h2 { font-size:1.15rem; margin:2.5rem 0 .5rem; }
  table { width:100%; border-collapse:collapse; margin:.5rem 0 1.5rem; font-size:.9rem;
          display:block; overflow-x:auto; }
  th, td { text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); }
  th { font-size:.75rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  td.muted { color:var(--muted); font-size:.85rem; }
  tr.tot td { border-top:2px solid var(--line); border-bottom:none; }
  code { font-family:ui-monospace,monospace; font-size:.85em; }
  .date { font-size:.78rem; color:var(--muted); font-variant-numeric:tabular-nums; }
  .rangeline { font-size:.8rem; color:var(--muted); margin:-.3rem 0 .7rem; }
  .range time { font-variant-numeric:tabular-nums; }
  .win { font-size:.75rem; color:var(--muted); margin:.15rem 0 .1rem;
         font-variant-numeric:tabular-nums; }
  time { border-bottom:1px dotted var(--line); cursor:help; }
  pre { white-space:pre-wrap; word-break:break-word; margin:.2rem 0 0;
        font:13px/1.5 ui-monospace,monospace; background:var(--bg);
        border:1px solid var(--line); border-radius:6px; padding:.5rem; overflow-x:auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Regresión de 100 preguntas</h1>
  <p class="sub">Conversation Memory Assistant · generado el ${new Date().toLocaleString("es")}</p>

  <div class="warnbox">
    <strong>Contiene evidencia real de la conversación</strong>, incluidos mensajes de terceros.
    Archivo local, fuera de git. No compartir ni subir a ningún servicio.
  </div>

  <div class="stats">
    <div class="stat"><b>${stats.total}</b><span>preguntas</span></div>
    <div class="stat"><b>${stats.verified}</b><span>verificadas</span></div>
    <div class="stat"><b>${stats.insufficient}</b><span>evidencia citada, modelo dijo insuficiente</span></div>
    <div class="stat"><b>${stats.noEvidence}</b><span>sin evidencia recuperada</span></div>
    <div class="stat"><b>${stats.unsupported}</b><span>cita índice inexistente</span></div>
    <div class="stat"><b>${stats.errors}</b><span>errores</span></div>
  </div>

  <div class="filters" id="filters">
    <button data-f="all" aria-pressed="true">Todas (${stats.total})</button>
    <button data-f="ok" aria-pressed="false">Verificadas (${stats.verified})</button>
    <button data-f="warn" aria-pressed="false">Insuficiente (${stats.insufficient})</button>
    <button data-f="none" aria-pressed="false">Sin evidencia (${stats.noEvidence})</button>
    <button data-f="bad" aria-pressed="false">Índice inexistente (${stats.unsupported})</button>
  </div>

  <p class="sub">Intents detectados: ${[...byIntent]
    .sort((a, b) => b[1] - a[1])
    .map(([i, c]) => `${escapeHtml(i)} (${c})`)
    .join(" · ")}</p>

  ${costSection}

  <h2>Respuestas</h2>
  ${cards}
</div>
<script>
  const btns = document.querySelectorAll("#filters button");
  btns.forEach((b) => b.addEventListener("click", () => {
    btns.forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    const f = b.dataset.f;
    document.querySelectorAll(".card").forEach((c) => {
      c.style.display = f === "all" || c.dataset.status === f ? "" : "none";
    });
  }));
</script>
</body>
</html>`;

  await writeFile(OUTPUT, html, "utf8");
  console.log(`Reporte escrito: ${OUTPUT}`);
  console.log(
    `  ${stats.total} preguntas · ${stats.verified} verificadas · ${stats.insufficient} "insuficiente" · ${stats.noEvidence} sin evidencia · ${stats.unsupported} con índice inexistente · ${stats.errors} errores`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
