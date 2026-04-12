# Slots — reference

Each slot is a stable contract identified by string. Adding new slots is
non-breaking; changing/removing a slot requires a major `apiVersion` bump.

| Slot ID | Where it renders | Props the component gets | Meta fields |
|---|---|---|---|
| `sidebar.item` | Project sidebar, "Plugins" group | `{ ctx, meta }` | `{ label, icon?, order? }` |
| `project.page` | Full page at `/plugin-pages/<plugin>/<path>` | `{ ctx, subPath, meta }` | `{ path, title, icon? }` |
| `agent.page` | Full page at `/agents/<id>/plugin-pages/<plugin>/<path>` | `{ ctx, subPath, meta }` | `{ path, title }` |
| `agent.settings.tab` | Tab in Agent settings | `{ ctx, meta }` | `{ label, icon?, order? }` |
| `project.settings.section` | Section in Project settings | `{ ctx, meta }` | `{ label, icon?, order? }` |
| `dashboard.widget` | Project dashboard grid | `{ ctx, meta, size }` | `{ title, defaultSize?, order? }` |
| `chat.compose.action` | Chat composer toolbar | `{ ctx, meta, conversationId }` | `{ label, icon?, order? }` |
| `chat.message.action` | Per-message action menu | `{ ctx, meta, messageId }` | `{ label, icon?, order? }` |
| `conversation.panel.right` | Right panel inside chat | `{ ctx, meta, conversationId }` | `{ label, icon?, order? }` |
| `command.palette.item` | Cmd+K palette | `{ ctx, meta }` | `{ label, keywords? }` |
| `global.modal` | Modal mounted via `ctx.ui.openModal` | `{ ctx, meta, props }` | `{ id }` |

## Fase-1 wiring status

The following slots are **mounted in Studio**: `sidebar.item`, `project.page`, `project.settings.section` (via Plugin Inspector / Settings card), `dashboard.widget` (scaffold).
Other slots have the contract defined in `@jiku/kit/ui` but are not yet mounted in host surfaces. Plugins declaring them are safely stored in the registry — they will light up as the host mounts each slot.
