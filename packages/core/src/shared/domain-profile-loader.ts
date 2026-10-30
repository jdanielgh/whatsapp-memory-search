// Carga el perfil de dominio activo. Es el único lugar que lee el archivo
// de perfil; el resto del código recibe el perfil por parámetro.

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { GENERIC_PROFILE } from "./generic-profile.js";
import { parseDomainProfile, type DomainProfile } from "./domain-profile.js";
import { REPO_ROOT } from "./repo-paths.js";

/**
 * Una ruta relativa se resuelve contra la raíz del repo, que es donde vive el
 * `.env` que la define, y no contra el directorio desde donde se lanzó el
 * comando: de lo contrario el mismo `.env` funcionaba con `npm run` desde la
 * raíz y fallaba al correr un script desde `packages/core`.
 */
export function loadDomainProfile(profilePath: string | null): DomainProfile {
  if (!profilePath) return GENERIC_PROFILE;

  const resolved = path.resolve(REPO_ROOT, profilePath);
  let text: string;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`No se pudo leer el perfil de dominio en ${resolved} (DOMAIN_PROFILE_PATH).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`El perfil de dominio en ${resolved} no es JSON válido.`);
  }
  return parseDomainProfile(parsed);
}

let active: DomainProfile | undefined;

/** Perfil activo según `DOMAIN_PROFILE_PATH`; vacío = perfil genérico. */
export function getActiveDomainProfile(): DomainProfile {
  active ??= loadDomainProfile(config.domainProfilePath);
  return active;
}
