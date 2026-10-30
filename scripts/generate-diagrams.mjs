// Exporta a SVG los diagramas Mermaid embebidos en docs/VISUAL_GUIDE.md.
//
// GitHub ya renderiza los bloques ```mermaid del propio Markdown, así que
// estos SVG no hacen falta para leer la guía: existen para poder reusar
// los diagramas fuera del repo (una presentación, un PDF, un issue).
//
// La fuente de verdad es SIEMPRE el Markdown. Los SVG se regeneran con
// `npm run docs:diagrams`; no se editan a mano, porque el siguiente
// regenerado los pisaría sin avisar.
//
// Requiere @mermaid-js/mermaid-cli, que se descarga con npx bajo demanda
// (arrastra un Chromium, por eso no es una dependencia del proyecto).

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SOURCE = "docs/VISUAL_GUIDE.md";
const OUT_DIR = "docs/diagrams";

/** Convierte "3. El Pipeline General, etapa por etapa" en "03-el-pipeline-general-etapa-por-etapa". */
function slugify(heading) {
  const [, number, rest] = heading.match(/^(\d+)\.\s*(.*)$/) ?? [null, "0", heading];
  const slug = rest
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${number.padStart(2, "0")}-${slug}`;
}

const markdown = readFileSync(SOURCE, "utf8");

// Recorre el documento guardando el último encabezado de nivel 2 visto,
// para poder nombrar cada diagrama por su sección en vez de por su orden.
const blocks = [];
let currentHeading = "sin-seccion";
let inside = false;
let buffer = [];

for (const line of markdown.split("\n")) {
  if (!inside && line.startsWith("## ")) {
    currentHeading = line.slice(3).trim();
    continue;
  }
  if (!inside && line.trim() === "```mermaid") {
    inside = true;
    buffer = [];
    continue;
  }
  if (inside && line.trim() === "```") {
    inside = false;
    blocks.push({ name: slugify(currentHeading), source: buffer.join("\n") });
    continue;
  }
  if (inside) buffer.push(line);
}

if (blocks.length === 0) {
  console.error(`No se encontró ningún bloque mermaid en ${SOURCE}.`);
  process.exit(1);
}

/**
 * En Windows, `npx` es un `.cmd` y lanzarlo sin shell falla con EINVAL
 * (mismo tropiezo ya documentado en el E2E de `cli-import`). Con shell
 * hay que citar los argumentos a mano, porque la ruta del proyecto tiene
 * espacios.
 */
function runMermaid(args) {
  if (process.platform !== "win32") {
    execFileSync("npx", args, { stdio: "pipe" });
    return;
  }
  const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  execSync(`npx ${quoted}`, { stdio: "pipe" });
}

const scratch = join(tmpdir(), `cma-diagrams-${process.pid}`);
mkdirSync(scratch, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
try {
  for (const { name, source } of blocks) {
    const input = join(scratch, `${name}.mmd`);
    writeFileSync(input, source);
    const output = join(OUT_DIR, `${name}.svg`);
    try {
      runMermaid([
        "--yes",
        "@mermaid-js/mermaid-cli@latest",
        "-i", input,
        "-o", output,
        "-b", "transparent",
      ]);
      console.log(`OK    ${output}`);
    } catch (err) {
      failures += 1;
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`FALLA ${output}\n${detail.split("\n").slice(-5).join("\n")}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${blocks.length - failures}/${blocks.length} diagramas exportados a ${OUT_DIR}/`);
process.exitCode = failures === 0 ? 0 : 1;
