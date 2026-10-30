# archive

Archive Layer (docs/ARCHITECTURE.md). Preserva la evidencia: `Conversation`,
`Participant`, `Message`, `Attachment`, `ImportJob`, `Source`.

Nota: docs/ARCHITECTURE.md lista `conversation/` como carpeta hermana de
`archive/` en el árbol de `src/`, pero la sección "Capas" del mismo
documento pone `Conversation` como componente de la Archive Layer. Se
resuelve aquí a favor de la sección "Capas": `Conversation` vive dentro
de `archive/domain`, no en una carpeta separada. Si esto se revierte,
ajustar `plans/`.

- `domain/` — entidades `Conversation`, `Participant`, `Message`,
  `Attachment`, `ImportJob`, `Source` (sin dependencias externas).
- `use-cases/` — `ImportConversation` (UC-001), `SyncNewMessages`
  (UC-002). Ver `plans/`.
- `repositories/` — interfaz `ConversationRepository` (único repositorio
  del Aggregate, AG-002/AG-003).
- `infrastructure/` — implementación Postgres del repositorio, parser de
  WhatsApp (`whatsapp-parser.ts`).

Nunca ejecuta IA. Nunca interpreta información (docs/ARCHITECTURE.md).
