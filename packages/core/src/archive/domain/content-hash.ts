// Hash de integridad para dedup de mensajes (docs/SECURITY.md,
// "Integridad"; .claude/skills/whatsapp-ingest/SKILL.md: dedup por
// `sent_at + participant_id + content`). No es un secreto — solo debe
// ser determinístico y estable entre corridas para que reimportar el
// mismo archivo no duplique mensajes (PL-004/SI-031).

import { createHash } from "node:crypto";

export function computeContentHash(
  sentAt: Date,
  participantId: string,
  content: string
): string {
  return createHash("sha256")
    .update(`${sentAt.toISOString()}|${participantId}|${content}`)
    .digest("hex");
}
