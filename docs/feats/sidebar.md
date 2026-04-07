# Feature: Sidebar System

## What It Does

Three-level sidebar navigation for the Studio web app. Each layout level renders its own `SidebarProvider` shell and its own sidebar component. Sidebars are collapsible (shadcn Sidebar primitives).

## Sidebar Levels

### 1. Root Sidebar (`components/sidebar/root-sidebar.tsx`)

Rendered at the `/studio` layout level. Shows:
- Company switcher / company list
- User info dropdown in `SidebarFooter`

### 2. Company Sidebar (`components/sidebar/company-sidebar.tsx`)

Rendered at the `/studio/companies/[company]` layout level. Shows:
- Company name header
- Nav group: Projects, Settings (no separator between them)
- User info dropdown in `SidebarFooter` (same pattern as root sidebar)

### 3. Project Sidebar (`components/sidebar/project-sidebar.tsx`)

Rendered at the `/studio/companies/[company]/projects/[project]` layout level. Shows:
- Project name header
- Nav group: Dashboard, Agents, Chats, Settings (all in one group, no separator before Settings)
- User info dropdown in `SidebarFooter`

## Conventions

- **Settings placement**: Settings always lives in the same `SidebarGroup` as the primary nav items — no `SidebarSeparator` before it.
- **User info footer**: Every sidebar level renders a user info dropdown in `SidebarFooter`, with a `ThemeToggle` button to its right. Footer uses `flex items-center gap-1` wrapper; `SidebarMenuButton` (inside `DropdownMenuTrigger`) has `flex-1` so it takes available space and the toggle stays right-aligned.
- **Theme toggle**: `components/theme-toggle.tsx` — `ThemeToggle` component using `next-themes` `useTheme`. Sun/Moon icon swap with CSS transition. `ThemeProvider` is already configured in `providers.tsx`.
- **AppHeader + Breadcrumb**: Each layout level renders `AppHeader` with a `SidebarTrigger`. `AppBreadcrumb` resolves company/project/agent display names from TanStack Query cache.

## App Breadcrumb

`components/sidebar/app-breadcrumb.tsx` — reads the current URL segments and resolves display names by looking up TanStack Query cache entries for companies/projects/agents. Falls back to the slug if cache is empty.

## Error Boundaries

Each route segment has a Next.js `error.tsx` co-located error boundary:
- `studio/companies/[company]/error.tsx`
- `studio/companies/[company]/projects/[project]/error.tsx`
- `studio/companies/[company]/projects/[project]/agents/[agent]/error.tsx`

A reusable `components/error-boundary.tsx` React class component is also available for in-component error catching.

## Related Files

- `apps/studio/web/components/theme-toggle.tsx` — dark/light toggle button
- `apps/studio/web/components/sidebar/root-sidebar.tsx`
- `apps/studio/web/components/sidebar/company-sidebar.tsx`
- `apps/studio/web/components/sidebar/project-sidebar.tsx`
- `apps/studio/web/components/sidebar/app-breadcrumb.tsx`
- `apps/studio/web/app/(app)/layout.tsx` — root layout, renders root sidebar
- `apps/studio/web/app/(app)/studio/companies/[company]/layout.tsx` — company layout
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/layout.tsx` — project layout (with ResizablePanelGroup for chats)

## Known Limitations

- Breadcrumb display names depend on TanStack Query cache being populated — on hard refresh to a deep route, names may briefly show slugs
- Sidebar state (open/collapsed) is not persisted across page reloads
