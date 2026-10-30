// Rutas ancladas a la ubicación de este archivo, no al directorio actual.
// En el monorepo, `npm run <script> -w @cma/core` ejecuta con cwd =
// packages/core, mientras que `.env`, `backups/` y `.claude/state/`
// viven en la raíz del repo. Resolver contra process.cwd() haría que el
// mismo comando lea o escriba en lugares distintos según desde dónde se
// lance.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** packages/core */
export const CORE_ROOT = path.resolve(here, "../..");

/** Raíz del monorepo. */
export const REPO_ROOT = path.resolve(CORE_ROOT, "../..");
