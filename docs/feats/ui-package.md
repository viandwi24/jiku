# Feature: @jiku/ui Shared Component Library

## What it does

`@jiku/ui` is the shared React component library for the Jiku monorepo. It contains:

- **Layout components** — Sidebar, Header, PageHeader, EmptyState
- **Data components** — DataTable, StatCard, PermissionBadge
- **Agent components** — ChatBubble, ChatInput, ThinkingIndicator, ToolCallView
- **UI primitives** (shadcn/radix-based) — 55 components including Button, Input, Dialog, Dropdown, Tabs, etc.
- **AI Elements** — 48 components for AI chat UIs: Message, PromptInput, Conversation, Tool, Reasoning, CodeBlock, etc.
- **Hooks** — `useIsMobile`
- **Utils** — `cn()` (clsx + tailwind-merge)

## Public API

```ts
import { Button, Input, Dialog } from '@jiku/ui'             // shadcn primitives
import { Message, PromptInput, Conversation } from '@jiku/ui' // ai-elements
import { Sidebar, DataTable, ChatBubble } from '@jiku/ui'     // layout/data/agent
import { cn, useIsMobile } from '@jiku/ui'                    // utils + hooks
```

All components are barrel-exported from `packages/ui/src/index.ts`.

## File Layout

```
packages/ui/src/
  index.ts                        — barrel exports
  lib/utils.ts                    — cn()
  hooks/use-mobile.ts             — useIsMobile
  components/
    layout/                       — Sidebar, Header, PageHeader, EmptyState
    data/                         — DataTable, StatCard, PermissionBadge
    agent/                        — ChatBubble, ChatInput, ThinkingIndicator, ToolCallView
    ui/                           — 55 shadcn primitives (accordion, button, dialog, ...)
    ai-elements/                  — 48 AI-specific components (message, tool, canvas, ...)
```

## Import Path Conventions (within packages/ui)

From `components/ui/*.tsx`:
- `../../lib/utils` for `cn()`
- `./other-component` for sibling ui components

From `components/ai-elements/*.tsx`:
- `../../lib/utils` for `cn()`
- `../ui/component-name` for ui primitives
- `./sibling` for sibling ai-elements

## Third-party Dependencies (ai-elements)

Several ai-elements have specialized peer dependencies:
- `ai` — Vercel AI SDK types (Tool, UIMessage, ToolUIPart, etc.)
- `@xyflow/react` — canvas, edge, node, connection, controls, panel, toolbar
- `streamdown` + `@streamdown/*` — message and reasoning markdown streaming
- `motion/react` — shimmer animations
- `@rive-app/react-webgl2` — persona animation
- `media-chrome/react` — audio-player
- `use-stick-to-bottom` — conversation auto-scroll
- `tokenlens` — context token counting
- `nanoid` — prompt-input ID generation
- `ansi-to-react` — terminal ANSI output

## Known Limitations

- `apps/studio/web` still has local copies of ui/ and ai-elements/ — import-update pass needed
- No storybook or visual testing yet
- Some ai-elements (canvas, edge, node, etc.) require ReactFlow provider in parent tree

## Related Files

- `packages/ui/src/index.ts` — main entry point
- `packages/ui/package.json` — package config
- `apps/studio/web/components/ui/` — original source (to be removed after import migration)
- `apps/studio/web/components/ai-elements/` — original source (to be removed after import migration)
