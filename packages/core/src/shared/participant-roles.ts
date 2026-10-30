// Parseo del mapeo "nombre mostrado -> rol" (docs/DATA_MODEL.md:
// participants.role) compartido entre la fuente por defecto
// (PARTICIPANT_ROLE_MAP en .env, ver config.ts) y el override puntual
// por CLI (--roles en cli-import.ts). Mismo formato para los dos:
// "Nombre1=rol1,Nombre2=rol2".

export function parseParticipantRoles(raw: string): Record<string, string> {
  const roles: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [name, role] = pair.split("=").map((s) => s?.trim());
    if (!name || !role) {
      throw new Error(
        `Mapeo de roles mal formado cerca de "${pair}". Formato esperado: "Nombre1=rol1,Nombre2=rol2".`
      );
    }
    roles[name] = role;
  }
  return roles;
}
