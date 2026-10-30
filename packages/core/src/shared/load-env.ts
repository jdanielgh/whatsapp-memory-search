// Carga el `.env` de la raíz del monorepo (ver repo-paths.ts). Las
// variables ya definidas en el entorno tienen prioridad: en un servidor
// se inyectan así y el archivo puede no existir.

import path from "node:path";
import { config } from "dotenv";
import { REPO_ROOT } from "./repo-paths.js";

config({ path: path.join(REPO_ROOT, ".env") });
