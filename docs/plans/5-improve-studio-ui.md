# Plan 5 — Studio Web UI/UX Overhaul

> Status: **PLANNING**
> Date: 2026-04-05
> Depends on: Plan 4 (Credentials System)
> Stack: Next.js 15 App Router, shadcn/ui, TanStack Query, Zustand

---

## Daftar Isi

1. [Scope & Goals](#1-scope--goals)
2. [Shadcn Component Mapping](#2-shadcn-component-mapping)
3. [Navigation Architecture](#3-navigation-architecture)
4. [Route Structure](#4-route-structure)
5. [3-Level Sidebar System](#5-3-level-sidebar-system)
6. [Layout Shells](#6-layout-shells)
7. [Root Level — Home](#7-root-level--home)
8. [Company Level](#8-company-level)
9. [Project Level](#9-project-level)
10. [Chat System — OpenClaw Style](#10-chat-system--openclaw-style)
11. [Agent Page — Tabs](#11-agent-page--tabs)
12. [Settings Pages — Tabs](#12-settings-pages--tabs)
13. [Shared UI Patterns](#13-shared-ui-patterns)
14. [State Management](#14-state-management)
15. [packages/ui — Component Inventory](#15-packagesui--component-inventory)
16. [File Changes](#16-file-changes)
17. [Implementation Checklist](#17-implementation-checklist)

---

## 1. Scope & Goals

### Yang Dikerjakan

| Area | Item |
|------|------|
| Navigation | 3-level sidebar system menggunakan shadcn `Sidebar` |
| Chats | Project-wide chat ala OpenClaw — semua agent, conversation list |
| Tabs | Agent page + Settings pages pakai shadcn `Tabs` URL-based |
| Layout | Context-aware shell per level dengan shadcn `SidebarProvider` |
| Polish | Loading (shadcn `Skeleton`), empty (shadcn `Empty`), breadcrumb, toast (shadcn `Sonner`) |

### Design Principles

- **Shadcn first** — pakai shadcn component sebelum custom
- **URL-based state** — tab aktif, conversation aktif ada di URL (survives refresh)
- **Minimal custom CSS** — semua via Tailwind utilities
- **Dark mode** — semua component support dark mode via shadcn theming

### Out of Scope

- Dashboard widget/stats (placeholder dulu)
- Plugin management UI
- Task mode UI
- Mobile responsive

---

## 2. Shadcn Component Mapping

Pemetaan kebutuhan UI ke shadcn component yang tepat:

| Kebutuhan | Shadcn Component | Notes |
|-----------|-----------------|-------|
| Sidebar (3 level) | `Sidebar`, `SidebarProvider`, `SidebarContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton` | Built-in collapsible support |
| Breadcrumb di header | `Breadcrumb`, `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbLink`, `BreadcrumbSeparator`, `BreadcrumbPage` | Sudah lengkap |
| Tabs (agent, settings) | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Pakai untuk state-based; URL-based via Next.js Link |
| Conversation list | `ScrollArea` + custom item | shadcn ScrollArea untuk scroll container |
| Chat messages | `ScrollArea` + custom bubble | |
| Agent selector (input) | `Popover` + `Command` (Combobox pattern) | Filter + search agent |
| Input bar | `Textarea` + `Button` | Auto-resize textarea |
| Tool call view | `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` | Expandable tool result |
| Company/Project card | `Card`, `CardContent`, `CardFooter` | |
| Empty state | `Empty`, `EmptyTitle`, `EmptyDescription`, `EmptyContent` | Shadcn baru (Oct 2025) |
| Loading skeleton | `Skeleton` | Sidebar, card, chat bubble variants |
| Toast | `Sonner` | Success, error, info |
| Dialogs (create/edit) | `Dialog`, `DialogContent`, `DialogHeader`, `DialogFooter` | |
| Dropdown actions | `DropdownMenu` | Gear icon menu |
| Avatar | `Avatar`, `AvatarFallback` | User + agent initials |
| Badge | `Badge` | Project count, status |
| Separator | `Separator` | Sidebar section divider |
| Tooltip | `Tooltip` | Collapsed sidebar icon hints |

### Custom Components (tidak ada di shadcn)

| Kebutuhan | Custom Component | Alasan |
|-----------|-----------------|--------|
| Chat bubble (user/assistant) | `ChatBubble` | Layout khas chat, tidak ada di shadcn |
| Conversation list item | `ConversationItem` | Composite — agent avatar + preview + time |
| Agent card (project) | `AgentCard` | Composite — avatar + model info + actions |
| Thinking indicator | `ThinkingIndicator` | Animated dots, tidak ada di shadcn |

---

## 3. Navigation Architecture

### Replace Pattern — Satu Sidebar Per Level

```
/home              → RootSidebar (Dashboard, Companies)
/[company]         → CompanySidebar (Dashboard, Projects, Settings)
/[company]/[proj]  → ProjectSidebar (Dashboard, Agents, Chats, Settings)
```

Ketika masuk ke level lebih dalam, sidebar sebelumnya **hilang** dan diganti. Tidak berdampingan. Ini pattern yang dipakai Linear, Vercel, Raycast.

### Breadcrumb = Konteks Navigasi

```
Header selalu punya: Home > Bitorex > Trading Platform > Agents > Social Manager
Tiap segment = link ke level tersebut
```

### Back Navigation

Sidebar punya back button di atas:
```
CompanySidebar: ← Home
ProjectSidebar: ← Bitorex
AgentPage:      ← Trading Platform (via breadcrumb)
```

---

## 4. Route Structure

```
app/
├── (auth)/
│   ├── login/page.tsx
│   └── register/page.tsx
│
└── (app)/
    ├── layout.tsx                   ← providers: TanStack, Zustand, Theme, Sonner
    │
    ├── home/
    │   ├── layout.tsx               ← RootShell (SidebarProvider + RootSidebar)
    │   └── page.tsx                 ← company list + dashboard placeholder
    │
    └── [company]/
        ├── layout.tsx               ← CompanyShell (SidebarProvider + CompanySidebar)
        ├── page.tsx                 ← project list + dashboard placeholder
        ├── settings/
        │   ├── layout.tsx           ← settings shell dengan tabs
        │   ├── page.tsx             ← general settings (redirect ke /settings/general)
        │   ├── general/page.tsx     ← edit name/slug + danger zone
        │   └── credentials/page.tsx ← company credentials
        │
        └── [project]/
            ├── layout.tsx           ← ProjectShell (SidebarProvider + ProjectSidebar)
            ├── page.tsx             ← agent list + dashboard placeholder
            ├── agents/
            │   └── [agent]/
            │       ├── layout.tsx   ← AgentLayout (breadcrumb header + tabs)
            │       ├── page.tsx     ← overview tab
            │       ├── settings/
            │       │   ├── page.tsx         ← settings tab: general
            │       │   └── model/page.tsx   ← settings tab: model & provider
            │       └── permissions/page.tsx ← permissions tab
            ├── chats/
            │   ├── layout.tsx       ← ChatShell (resizable split: list + area)
            │   ├── page.tsx         ← empty state / new chat
            │   └── [conv]/page.tsx  ← active conversation
            └── settings/
                ├── layout.tsx       ← settings shell dengan tabs
                ├── page.tsx         ← redirect ke /settings/general
                ├── general/page.tsx
                ├── credentials/page.tsx
                └── permissions/page.tsx
```

---

## 5. 3-Level Sidebar System

### Implementasi dengan shadcn `Sidebar`

Shadcn `Sidebar` sudah include:
- `SidebarProvider` — context + collapse state
- `SidebarTrigger` — collapse toggle button
- `SidebarInset` — main content area
- `SidebarHeader`, `SidebarContent`, `SidebarFooter`
- `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`
- `SidebarMenuBadge` — count badge
- `SidebarSeparator` — divider
- `SidebarGroup`, `SidebarGroupLabel`, `SidebarGroupContent`

### Root Sidebar

```typescript
// components/sidebar/root-sidebar.tsx

<Sidebar>
  <SidebarHeader>
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Avatar className="h-7 w-7">
        <AvatarFallback>J</AvatarFallback>
      </Avatar>
      <span className="font-medium text-sm">Jiku</span>
    </div>
  </SidebarHeader>

  <SidebarContent>
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === '/home'}>
              <Link href="/home">
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === '/home/companies'}>
              <Link href="/home">
                <Building2 className="h-4 w-4" />
                Companies
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </SidebarContent>

  <SidebarFooter>
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton>
              <Avatar className="h-6 w-6">
                <AvatarFallback>{user.name[0]}</AvatarFallback>
              </Avatar>
              <span className="flex-1 text-left">{user.name}</span>
              <ChevronsUpDown className="h-4 w-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Profile</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarFooter>
</Sidebar>
```

### Company Sidebar

```typescript
// components/sidebar/company-sidebar.tsx

<Sidebar>
  <SidebarHeader>
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild>
          <Link href="/home">
            <ChevronLeft className="h-4 w-4" />
            Home
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
    <div className="flex items-center justify-between px-2 py-1">
      <span className="font-semibold text-sm">{company.name}</span>
      <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
        <Link href={`/${company.slug}/settings`}>
          <Settings className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  </SidebarHeader>

  <SidebarContent>
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isActive('/dashboard')}>
              <Link href={`/${company.slug}`}>
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={isActive('/projects')}>
              <Link href={`/${company.slug}`}>
                <FolderKanban className="h-4 w-4" />
                Projects
              </Link>
            </SidebarMenuButton>
            <SidebarMenuBadge>{projectCount}</SidebarMenuBadge>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>

    <SidebarSeparator />

    <SidebarGroup>
      <SidebarGroupLabel>Company</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link href={`/${company.slug}/settings/general`}>
                <Settings className="h-4 w-4" />
                Settings
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link href={`/${company.slug}/settings/credentials`}>
                <KeyRound className="h-4 w-4" />
                Credentials
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </SidebarContent>
</Sidebar>
```

### Project Sidebar

```typescript
// components/sidebar/project-sidebar.tsx

<Sidebar>
  <SidebarHeader>
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton asChild>
          <Link href={`/${company.slug}`}>
            <ChevronLeft className="h-4 w-4" />
            {company.name}
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
    <div className="flex items-center justify-between px-2 py-1">
      <span className="font-semibold text-sm truncate">{project.name}</span>
      <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
        <Link href={`/${company.slug}/${project.slug}/settings`}>
          <Settings className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  </SidebarHeader>

  <SidebarContent>
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {[
            { href: '', label: 'Dashboard', icon: LayoutDashboard },
            { href: '/agents', label: 'Agents', icon: Bot, badge: agentCount },
            { href: '/chats', label: 'Chats', icon: MessageSquare },
          ].map(item => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild isActive={isActive(item.href)}>
                <Link href={`/${company.slug}/${project.slug}${item.href}`}>
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </SidebarMenuButton>
              {item.badge && <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>

    <SidebarSeparator />

    <SidebarGroup>
      <SidebarGroupLabel>Config</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {[
            { href: '/settings/general',     label: 'Settings',     icon: Settings },
            { href: '/settings/credentials', label: 'Credentials',  icon: KeyRound },
            { href: '/settings/permissions', label: 'Permissions',  icon: ShieldCheck },
          ].map(item => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton asChild isActive={isActive(item.href)}>
                <Link href={`/${company.slug}/${project.slug}${item.href}`}>
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  </SidebarContent>
</Sidebar>
```

---

## 6. Layout Shells

### Shell Pattern — SidebarProvider per level

```typescript
// app/(app)/home/layout.tsx
export default function RootShell({ children }) {
  return (
    <SidebarProvider>
      <RootSidebar />
      <SidebarInset>
        <AppHeader />
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}

// app/(app)/[company]/layout.tsx
export default async function CompanyShell({ children, params }) {
  return (
    <SidebarProvider>
      <CompanySidebar companySlug={params.company} />
      <SidebarInset>
        <AppHeader />
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}

// app/(app)/[company]/[project]/layout.tsx
export default async function ProjectShell({ children, params }) {
  return (
    <SidebarProvider>
      <ProjectSidebar companySlug={params.company} projectSlug={params.project} />
      <SidebarInset>
        <AppHeader />
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
```

### App Header — Breadcrumb + SidebarTrigger

```typescript
// components/layout/app-header.tsx
// Sticky header di atas content area

export function AppHeader() {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />
      <AppBreadcrumb />    {/* Dynamic breadcrumb dari pathname */}
    </header>
  )
}
```

### Dynamic Breadcrumb

```typescript
// components/layout/app-breadcrumb.tsx
// Generate breadcrumb dari URL pathname + data

export function AppBreadcrumb() {
  const params = useParams()
  // Home > [company.name] > [project.name] > Agents > [agent.name]

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/home">Home</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {params.company && (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={`/${params.company}`}>{companyName}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </>
        )}
        {/* ... dst per level */}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
```

---

## 7. Root Level — Home

### `/home` Page

```typescript
// Konten:
// - Heading "Welcome back, {name}"
// - Grid company cards
// - "+ New Company" card/button

// Company card menggunakan shadcn Card:
<Card className="group cursor-pointer hover:shadow-sm transition-shadow">
  <CardContent className="pt-6">
    <div className="flex items-start justify-between">
      <div>
        <Avatar className="h-10 w-10 mb-3">
          <AvatarFallback className="text-lg">{company.name[0]}</AvatarFallback>
        </Avatar>
        <h3 className="font-semibold">{company.name}</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          {projectCount} project{projectCount !== 1 ? 's' : ''}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem asChild>
            <Link href={`/${company.slug}/settings/general`}>Settings</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </CardContent>
  <CardFooter>
    <Button asChild variant="ghost" className="w-full justify-between">
      <Link href={`/${company.slug}`}>
        Open <ChevronRight className="h-4 w-4" />
      </Link>
    </Button>
  </CardFooter>
</Card>
```

---

## 8. Company Level

### `/[company]` Page — Project List

```typescript
// Layout:
// - Page header: "Projects" + "+ New Project" button
// - Grid/list project cards

// Project card:
<Card className="group">
  <CardContent className="pt-4 pb-3">
    <div className="flex items-start justify-between mb-2">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center">
          <FolderKanban className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <h3 className="font-medium text-sm">{project.name}</h3>
          <p className="text-xs text-muted-foreground">{agentCount} agents</p>
        </div>
      </div>
      <DropdownMenu>...</DropdownMenu>
    </div>
  </CardContent>
  <CardFooter className="pt-0">
    <Button asChild size="sm" className="w-full">
      <Link href={`/${company.slug}/${project.slug}`}>
        Open project
      </Link>
    </Button>
  </CardFooter>
</Card>
```

---

## 9. Project Level

### `/[company]/[project]` Page — Agent List

```typescript
// Layout:
// - Page header: "Agents" + "+ New Agent" button
// - Agent cards (lebih informatif dari sebelumnya)

// Agent card — CUSTOM (tidak ada di shadcn):
export function AgentCard({ agent, companySlug, projectSlug }) {
  const credentialAssigned = !!agent.credential

  return (
    <Card className="group">
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start gap-3">
          <Avatar className="h-9 w-9 mt-0.5">
            <AvatarFallback className="text-sm bg-primary/10 text-primary">
              {agent.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-sm truncate">{agent.name}</h3>
              {!credentialAssigned && (
                <Badge variant="outline" className="text-xs text-amber-600 border-amber-300 bg-amber-50">
                  No credentials
                </Badge>
              )}
            </div>
            {credentialAssigned && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {agent.credential.adapter_id} · {agent.model_id}
              </p>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem asChild>
                <Link href={`/${companySlug}/${projectSlug}/agents/${agent.slug}`}>
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
      <CardFooter className="pt-0 gap-2">
        <Button asChild size="sm" className="flex-1" disabled={!credentialAssigned}>
          <Link href={`/${companySlug}/${projectSlug}/chats?agent=${agent.slug}`}>
            <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
            Chat
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className="flex-1">
          <Link href={`/${companySlug}/${projectSlug}/agents/${agent.slug}`}>
            Settings
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}
```

---

## 10. Chat System — OpenClaw Style

### Layout — Resizable Split Panel

```typescript
// app/(app)/[company]/[project]/chats/layout.tsx
// Pakai shadcn Resizable untuk split conversation list + chat area

export default function ChatShell({ children }) {
  return (
    <ResizablePanelGroup direction="horizontal" className="h-[calc(100vh-3rem)]">
      <ResizablePanel defaultSize={28} minSize={20} maxSize={40}>
        <ConversationListPanel />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={72}>
        {children}   {/* chat area atau empty state */}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
```

### Conversation List Panel

```typescript
// components/chat/conversation-list-panel.tsx

export function ConversationListPanel() {
  const params = useParams()
  const { data: conversations } = useConversations(params.project)

  return (
    <div className="flex flex-col h-full border-r">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b">
        <h2 className="font-semibold text-sm">Chats</h2>
        <Button size="sm" onClick={() => router.push(`...chats`)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          New
        </Button>
      </div>

      {/* Search — pakai shadcn Command sebagai combobox */}
      <div className="px-2 py-2 border-b">
        <Input placeholder="Search conversations..." className="h-8 text-sm" />
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        {conversations.length === 0 ? (
          <Empty className="py-12">
            <EmptyMedia variant="icon"><MessageSquare /></EmptyMedia>
            <EmptyTitle>No conversations</EmptyTitle>
            <EmptyDescription>Start chatting with an agent</EmptyDescription>
          </Empty>
        ) : (
          conversations.map(conv => (
            <ConversationItem key={conv.id} conversation={conv} />
          ))
        )}
      </ScrollArea>
    </div>
  )
}
```

### Conversation Item — Custom Component

```typescript
// components/chat/conversation-item.tsx
// Custom karena layout khas chat list

export function ConversationItem({ conversation, isActive }) {
  return (
    <Link href={`...chats/${conversation.id}`}>
      <div className={cn(
        "flex items-start gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-muted/50 transition-colors border-b border-border/40",
        isActive && "bg-muted border-l-2 border-l-primary"
      )}>
        <Avatar className="h-7 w-7 mt-0.5 shrink-0">
          <AvatarFallback className="text-xs">
            {conversation.agent.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-medium truncate">
              {conversation.agent.name}
            </span>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatRelativeTime(conversation.updated_at)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {conversation.last_message ?? 'No messages yet'}
          </p>
        </div>
      </div>
    </Link>
  )
}
```

### New Chat Page — `/chats` (no conv selected)

```typescript
// app/(app)/[company]/[project]/chats/page.tsx

// Ketika user di /chats tanpa conversation:
// → tampil empty state di panel kanan
// → agent selector sudah aktif kalau ada ?agent= query param

export default function ChatsPage({ searchParams }) {
  const preselectedAgent = searchParams.agent  // dari ?agent=[slug]

  return (
    <div className="flex flex-col h-full items-center justify-end pb-4">
      {/* Empty area atas */}
      <div className="flex-1 flex items-center justify-center">
        <Empty>
          <EmptyMedia variant="icon"><MessageSquare /></EmptyMedia>
          <EmptyTitle>Start a conversation</EmptyTitle>
          <EmptyDescription>
            Select an agent and type a message to begin
          </EmptyDescription>
        </Empty>
      </div>

      {/* Input bar dengan agent selector — always visible */}
      <div className="w-full max-w-3xl px-4">
        <NewChatInputBar preselectedAgentSlug={preselectedAgent} />
      </div>
    </div>
  )
}
```

### Active Conversation — `/chats/[conv]`

```typescript
// app/(app)/[company]/[project]/chats/[conv]/page.tsx

export default function ConversationPage({ params }) {
  const { data: conversation } = useConversation(params.conv)
  const { data: messages } = useMessages(params.conv)

  return (
    <div className="flex flex-col h-full">
      {/* Conversation header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
        <Avatar className="h-6 w-6">
          <AvatarFallback className="text-xs">
            {conversation.agent.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="font-medium text-sm">{conversation.agent.name}</span>
        <Badge variant="outline" className="text-xs ml-auto">
          {conversation.agent.model_id}
        </Badge>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4">
        <div className="py-4 space-y-4 max-w-3xl mx-auto">
          {messages.map(msg => (
            <ChatBubble key={msg.id} message={msg} />
          ))}
          <ThinkingIndicator visible={isStreaming} />
        </div>
      </ScrollArea>

      {/* Input bar — agent selector disabled */}
      <div className="border-t px-4 py-3">
        <ChatInputBar
          conversationId={params.conv}
          agentName={conversation.agent.name}   // tampil tapi disabled
        />
      </div>
    </div>
  )
}
```

### Chat Input Bar — Custom Component

```typescript
// components/chat/chat-input-bar.tsx
// Custom karena layout unik (agent selector + textarea + send)

interface ChatInputBarProps {
  // New conversation mode:
  conversationId?: undefined
  agents?: Agent[]
  preselectedAgentSlug?: string
  onSend: (input: string, agentId: string) => Promise<void>

  // Existing conversation mode:
  conversationId?: string
  agentName?: string     // tampil sebagai disabled selector
  onSend: (input: string) => Promise<void>
}

// UI:
// ┌──────────────────────────────────────────────┐
// │ Agent: [Social Manager ▾]  (hidden if conv)  │
// ├──────────────────────────────────────────────┤
// │                                              │
// │  (Textarea — auto-resize, max 200px)         │
// │                                              │
// ├──────────────────────────────────────────────┤
// │                              [Send ↗]        │
// └──────────────────────────────────────────────┘

// Agent selector pakai shadcn Popover + Command (combobox pattern)
// Textarea pakai shadcn Textarea
// Send button pakai shadcn Button
// Enter to send, Shift+Enter untuk newline
```

### Agent Selector (Combobox) di Input Bar

```typescript
// Pakai shadcn Popover + Command — ini standard combobox pattern di shadcn

<Popover open={open} onOpenChange={setOpen}>
  <PopoverTrigger asChild>
    <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
      <Bot className="h-3.5 w-3.5" />
      {selectedAgent?.name ?? 'Select agent'}
      <ChevronsUpDown className="h-3 w-3 opacity-50" />
    </Button>
  </PopoverTrigger>
  <PopoverContent className="w-64 p-0" align="start">
    <Command>
      <CommandInput placeholder="Search agents..." className="h-9" />
      <CommandEmpty>No agents found.</CommandEmpty>
      <CommandList>
        {agents.map(agent => (
          <CommandItem
            key={agent.id}
            value={agent.name}
            onSelect={() => { setSelectedAgent(agent); setOpen(false) }}
          >
            <div className="flex flex-col">
              <span className="text-sm">{agent.name}</span>
              {agent.credential ? (
                <span className="text-xs text-muted-foreground">
                  {agent.credential.adapter_id} · {agent.model_id}
                </span>
              ) : (
                <span className="text-xs text-amber-500">No credentials</span>
              )}
            </div>
            <Check className={cn("ml-auto h-4 w-4", selectedAgent?.id === agent.id ? "opacity-100" : "opacity-0")} />
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  </PopoverContent>
</Popover>
```

### Chat Bubble — Custom Component

```typescript
// components/chat/chat-bubble.tsx
// Custom — layout chat khas, tidak ada di shadcn

export function ChatBubble({ message }) {
  const isUser = message.role === 'user'

  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      <Avatar className="h-7 w-7 shrink-0 mt-0.5">
        <AvatarFallback className="text-xs">
          {isUser ? 'U' : 'AI'}
        </AvatarFallback>
      </Avatar>
      <div className={cn(
        "max-w-[80%] space-y-2",
        isUser && "items-end"
      )}>
        {/* Text content */}
        {message.content.filter(c => c.type === 'text').map((c, i) => (
          <div key={i} className={cn(
            "rounded-2xl px-3.5 py-2.5 text-sm",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted"
          )}>
            {c.text}
          </div>
        ))}

        {/* Tool calls pakai shadcn Collapsible */}
        {message.content.filter(c => c.type === 'tool_call').map((c, i) => (
          <ToolCallView key={i} toolCall={c} />
        ))}
      </div>
    </div>
  )
}
```

### Tool Call View — shadcn Collapsible

```typescript
// components/chat/tool-call-view.tsx

export function ToolCallView({ toolCall }) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="bg-muted/50 rounded-lg border text-xs">
        <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted/70 rounded-lg">
          <Wrench className="h-3 w-3 text-muted-foreground" />
          <code className="flex-1 text-left">{toolCall.tool_id}()</code>
          <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3 pb-2 pt-1 border-t">
            <pre className="text-xs text-muted-foreground overflow-auto max-h-40">
              {JSON.stringify(toolCall.result, null, 2)}
            </pre>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
```

### Thinking Indicator — Custom

```typescript
// components/chat/thinking-indicator.tsx
// Simple animated dots — custom karena tidak ada di shadcn

export function ThinkingIndicator({ visible }) {
  if (!visible) return null
  return (
    <div className="flex gap-3">
      <Avatar className="h-7 w-7">
        <AvatarFallback className="text-xs">AI</AvatarFallback>
      </Avatar>
      <div className="bg-muted rounded-2xl px-3.5 py-3 flex gap-1">
        {[0, 1, 2].map(i => (
          <span key={i} className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 animate-bounce"
            style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  )
}
```

---

## 11. Agent Page — Tabs

### URL-based Tabs dengan shadcn Tabs + Next.js

```typescript
// app/(app)/[company]/[project]/agents/[agent]/layout.tsx

export default function AgentLayout({ children, params }) {
  const pathname = usePathname()
  const basePath = `/${params.company}/${params.project}/agents/${params.agent}`

  // Tabs mapping ke URL segments
  const tabs = [
    { value: 'overview',     label: 'Overview',     href: basePath },
    { value: 'settings',     label: 'Settings',     href: `${basePath}/settings` },
    { value: 'permissions',  label: 'Permissions',  href: `${basePath}/permissions` },
  ]

  const activeTab = tabs.find(t => pathname === t.href || pathname.startsWith(t.href + '/'))?.value ?? 'overview'

  return (
    <div className="flex flex-col h-full">
      {/* Agent header */}
      <div className="px-6 pt-6 pb-0 border-b">
        <div className="flex items-center gap-3 mb-4">
          <Avatar className="h-10 w-10">
            <AvatarFallback className="bg-primary/10 text-primary font-semibold">
              {agent.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div>
            <h1 className="font-semibold text-lg">{agent.name}</h1>
            <p className="text-sm text-muted-foreground">{agent.description}</p>
          </div>
          <Button asChild className="ml-auto">
            <Link href={`/${params.company}/${params.project}/chats?agent=${params.agent}`}>
              <MessageSquare className="h-4 w-4 mr-2" />
              Start Chat
            </Link>
          </Button>
        </div>

        {/* shadcn Tabs sebagai tab nav — URL-driven */}
        <Tabs value={activeTab}>
          <TabsList className="bg-transparent border-0 p-0 h-auto gap-0">
            {tabs.map(tab => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                asChild
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent pb-3 px-4"
              >
                <Link href={tab.href}>{tab.label}</Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}
```

### Agent Settings Tab — Sub-tabs

```typescript
// app/(app)/[company]/[project]/agents/[agent]/settings/layout.tsx
// Settings punya sub-tabs: General | Model & Provider

const settingsTabs = [
  { value: 'general', label: 'General', href: `${basePath}/settings` },
  { value: 'model',   label: 'Model & Provider', href: `${basePath}/settings/model` },
]
```

---

## 12. Settings Pages — Tabs

### Company Settings Tabs

```
/[company]/settings → redirect ke /settings/general

Tabs:
  General     → /[company]/settings/general
  Credentials → /[company]/settings/credentials
```

### Project Settings Tabs

```
/[company]/[project]/settings → redirect ke /settings/general

Tabs:
  General     → /[company]/[project]/settings/general
  Credentials → /[company]/[project]/settings/credentials
  Permissions → /[company]/[project]/settings/permissions
```

### Settings Shell

```typescript
// Reusable settings layout dengan tab nav di atas
// Pakai pola yang sama dengan agent layout

export function SettingsShell({ tabs, children }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <Tabs value={activeTab}>
        <TabsList className="mb-6">
          {tabs.map(tab => (
            <TabsTrigger key={tab.value} value={tab.value} asChild>
              <Link href={tab.href}>{tab.label}</Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </div>
  )
}
```

---

## 13. Shared UI Patterns

### Loading Skeleton

```typescript
// components/ui/skeletons.tsx
// Composable skeleton untuk berbagai konteks

// Sidebar skeleton
export function SidebarSkeleton() {
  return (
    <div className="p-3 space-y-2">
      {[...Array(5)].map((_, i) => (
        <Skeleton key={i} className="h-8 w-full rounded-md" />
      ))}
    </div>
  )
}

// Agent card skeleton
export function AgentCardSkeleton() {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start gap-3">
          <Skeleton className="h-9 w-9 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      </CardContent>
      <CardFooter className="gap-2">
        <Skeleton className="h-8 flex-1" />
        <Skeleton className="h-8 flex-1" />
      </CardFooter>
    </Card>
  )
}

// Chat bubble skeleton
export function ChatBubbleSkeleton() {
  return (
    <div className="flex gap-3">
      <Skeleton className="h-7 w-7 rounded-full shrink-0" />
      <div className="space-y-1.5">
        <Skeleton className="h-4 w-48 rounded-2xl" />
        <Skeleton className="h-4 w-32 rounded-2xl" />
      </div>
    </div>
  )
}
```

### Empty States — shadcn `Empty`

```typescript
// Pakai shadcn Empty component (baru Oct 2025)

// No agents:
<Empty>
  <EmptyMedia variant="icon"><Bot /></EmptyMedia>
  <EmptyTitle>No agents yet</EmptyTitle>
  <EmptyDescription>Create your first agent to get started</EmptyDescription>
  <EmptyContent>
    <Button onClick={openCreateDialog}>
      <Plus className="h-4 w-4 mr-2" />
      Create agent
    </Button>
  </EmptyContent>
</Empty>

// No credentials:
<Empty>
  <EmptyMedia variant="icon"><KeyRound /></EmptyMedia>
  <EmptyTitle>No credentials assigned</EmptyTitle>
  <EmptyDescription>Assign credentials to enable chatting</EmptyDescription>
  <EmptyContent>
    <Button asChild variant="outline">
      <Link href={`...settings/model`}>Assign credentials</Link>
    </Button>
  </EmptyContent>
</Empty>
```

### Toast — shadcn Sonner

```typescript
// Sudah include di shadcn via: npx shadcn add sonner
// Setup di app layout

// Usage:
import { toast } from 'sonner'

toast.success('Agent created')
toast.error('Failed to create agent')
toast.info('Credentials required to chat')
```

### Error Boundary

```typescript
// components/error-boundary.tsx
// Wrap major sections

// Tampil:
<div className="flex flex-col items-center justify-center h-full gap-3">
  <AlertCircle className="h-8 w-8 text-destructive" />
  <p className="font-medium">Something went wrong</p>
  <p className="text-sm text-muted-foreground">{error.message}</p>
  <Button variant="outline" onClick={reset}>Try again</Button>
</div>
```

---

## 14. State Management

### Zustand Stores — Revisi

```typescript
// lib/store/auth.store.ts — tidak berubah

// lib/store/chat.store.ts — NEW
interface ChatStore {
  // Agent yang dipilih untuk new conversation
  selectedAgentId: string | null
  setSelectedAgent: (id: string | null) => void
}

// lib/store/sidebar.store.ts — revisi
interface SidebarStore {
  // Tidak perlu simpan current company/project di store
  // → ambil dari URL params langsung
  // Hanya simpan collapse state
  isCollapsed: boolean
  toggle: () => void
}
```

### TanStack Query Keys

```typescript
// lib/query-keys.ts

export const queryKeys = {
  companies: ['companies'] as const,
  company: (slug: string) => ['companies', slug] as const,
  projects: (companySlug: string) => ['projects', companySlug] as const,
  project: (companySlug: string, projectSlug: string) => ['projects', companySlug, projectSlug] as const,
  agents: (projectId: string) => ['agents', projectId] as const,
  agent: (agentSlug: string) => ['agents', agentSlug] as const,
  conversations: (projectId: string) => ['conversations', projectId] as const,
  conversation: (convId: string) => ['conversations', convId] as const,
  messages: (convId: string) => ['messages', convId] as const,
}
```

---

## 15. packages/ui — Component Inventory

### Yang Pakai shadcn (re-export atau extend)

```
Sidebar, SidebarProvider, SidebarContent, SidebarMenu, dll  ← pakai langsung
Breadcrumb, BreadcrumbList, BreadcrumbItem, dll              ← pakai langsung
Tabs, TabsList, TabsTrigger, TabsContent                    ← pakai langsung
Card, CardContent, CardFooter                               ← pakai langsung
Collapsible, CollapsibleTrigger, CollapsibleContent         ← pakai langsung
Command, CommandInput, CommandList, CommandItem             ← untuk agent selector
Popover, PopoverTrigger, PopoverContent                    ← untuk agent selector
ScrollArea                                                  ← untuk chat + conv list
ResizablePanelGroup, ResizablePanel, ResizableHandle       ← untuk chat layout
Empty, EmptyTitle, EmptyDescription, EmptyContent          ← pakai langsung
Skeleton                                                    ← pakai langsung
Avatar, AvatarFallback                                      ← pakai langsung
Badge                                                       ← pakai langsung
Sonner (toast)                                              ← pakai langsung
```

### Custom Components (tambah ke packages/ui)

```
packages/ui/src/components/
  chat/
    chat-bubble.tsx            ← user/assistant bubble dengan tool call support
    conversation-item.tsx      ← item di conversation list
    thinking-indicator.tsx     ← animated dots
  agent/
    agent-card.tsx             ← card dengan credential info + Chat button
  layout/
    app-breadcrumb.tsx         ← dynamic breadcrumb dari pathname
    skeletons.tsx              ← sidebar, card, chat bubble skeletons
```

---

## 16. File Changes

### New Files

```
# Sidebar components
apps/studio/web/components/sidebar/
  root-sidebar.tsx
  company-sidebar.tsx
  project-sidebar.tsx

# Layout shells
apps/studio/web/components/layout/
  app-header.tsx
  app-breadcrumb.tsx

# Chat pages
apps/studio/web/app/(app)/[company]/[project]/chats/
  layout.tsx              ← ResizablePanelGroup
  page.tsx                ← new chat / empty state
  [conv]/page.tsx         ← active conversation

# Chat components
apps/studio/web/components/chat/
  conversation-list-panel.tsx
  conversation-item.tsx
  chat-bubble.tsx
  chat-input-bar.tsx
  tool-call-view.tsx
  thinking-indicator.tsx

# Skeletons
apps/studio/web/components/ui/
  skeletons.tsx

# packages/ui additions
packages/ui/src/components/chat/
  chat-bubble.tsx
  conversation-item.tsx
  thinking-indicator.tsx
packages/ui/src/components/agent/
  agent-card.tsx            ← revisi total
packages/ui/src/components/layout/
  app-breadcrumb.tsx
  skeletons.tsx
```

### Modified Files

```
# App router layouts — replace current
apps/studio/web/app/(app)/layout.tsx                          ← providers only
apps/studio/web/app/(app)/home/layout.tsx                    ← RootShell
apps/studio/web/app/(app)/[company]/layout.tsx               ← CompanyShell
apps/studio/web/app/(app)/[company]/[project]/layout.tsx     ← ProjectShell

# Agent page — tab-based
apps/studio/web/app/(app)/[company]/[project]/agents/[agent]/
  layout.tsx           ← AgentLayout dengan tabs
  page.tsx             ← Overview tab content

# Settings layouts — tab-based
apps/studio/web/app/(app)/[company]/settings/layout.tsx
apps/studio/web/app/(app)/[company]/[project]/settings/layout.tsx

# Project page — revisi agent card
apps/studio/web/app/(app)/[company]/[project]/page.tsx

# API — tambah conversation endpoints
apps/studio/web/lib/api.ts

# packages/ui exports
packages/ui/src/index.ts
```

### Server — Tambah Endpoints

```
GET  /api/projects/:pid/conversations        ← list semua conversations di project
GET  /api/conversations/:id                  ← detail + agent info
```

---

## 17. Implementation Checklist

### Priority 1 — Navigation (Blocker)

- [ ] shadcn `Sidebar` di-install (`npx shadcn add sidebar`)
- [ ] shadcn `Resizable` di-install (`npx shadcn add resizable`)
- [ ] shadcn `Empty` di-install (`npx shadcn add empty`)
- [ ] shadcn `Sonner` di-install (kalau belum)
- [ ] `RootSidebar` — Dashboard, Companies, user footer dengan dropdown
- [ ] `CompanySidebar` — back nav, projects badge, settings links
- [ ] `ProjectSidebar` — back nav, agents badge, chats, config section
- [ ] `AppHeader` — SidebarTrigger + Separator + breadcrumb
- [ ] `AppBreadcrumb` — dynamic dari pathname + params
- [ ] Layout shells: `home/layout`, `[company]/layout`, `[project]/layout`
- [ ] Redirect `/` → `/home`

### Priority 2 — Chat System

> **Note:** Chat UI components menggunakan `packages/ui/src/components/ai-elements` — JANGAN buat dari scratch.
> Mapping: `ChatBubble` → `Message`+`MessageContent`+`MessageResponse`, `ToolCallView` → `Tool`+`ToolHeader`+`ToolContent`+`ToolInput`+`ToolOutput`,
> `ThinkingIndicator` → `Reasoning`+`ReasoningTrigger`+`ReasoningContent` (auto open/close), `ChatInputBar` → `PromptInput`+`PromptInputTextarea`+`PromptInputSubmit`,
> Agent selector → `PromptInputCommand`, Scroll container → `Conversation`+`ConversationContent`+`ConversationScrollButton`

- [ ] Server: `GET /api/projects/:pid/conversations`
- [ ] Server: `GET /api/conversations/:id`
- [ ] `lib/api.ts` — conversations endpoints
- [ ] Chat layout: `ResizablePanelGroup` split
- [ ] `ConversationListPanel` — list + search + new button
- [ ] `ConversationItem` — avatar + preview + time
- [ ] `/chats` page — empty state + `PromptInput` (new chat input bar dengan agent selector)
- [ ] `/chats/[conv]` page — `Conversation`+`ConversationContent` + messages + input bar
- [ ] Messages rendering — `Message`+`MessageContent`+`MessageResponse` dari ai-elements
- [ ] Tool calls — `Tool`+`ToolHeader`+`ToolContent`+`ToolInput`+`ToolOutput` dari ai-elements
- [ ] Thinking/streaming — `Reasoning`+`ReasoningTrigger`+`ReasoningContent` dari ai-elements
- [ ] `PromptInput` wired ke `useChat` — agent selector via `PromptInputCommand` (new conv), disabled (existing conv)
- [ ] New chat flow — create conversation on first send → redirect to /chats/[id]
- [ ] Agent selector disappears/disabled setelah conversation started

### Priority 3 — Agent Card + Tabs

- [ ] `AgentCard` revisi — credential info + Chat button + warning badge
- [ ] Agent page layout dengan tabs (Overview, Settings, Permissions)
- [ ] URL-based tabs via pathname matching
- [ ] Agent overview tab content
- [ ] Agent settings sub-tabs (General, Model & Provider)
- [ ] Company settings layout dengan tabs
- [ ] Project settings layout dengan tabs

### Priority 4 — Polish

- [ ] Skeleton components — sidebar, agent card, chat bubble
- [ ] Suspense boundaries di setiap major section
- [ ] Empty states semua page dengan shadcn `Empty`
- [ ] Error boundary
- [ ] Toast (Sonner) untuk semua actions (create, delete, save)
- [ ] Loading state di buttons (disabled + spinner saat mutation)
- [ ] `packages/ui` export update

---

## Notes untuk AI Builder

### shadcn Installation Order

```bash
npx shadcn add sidebar
npx shadcn add resizable
npx shadcn add empty
npx shadcn add sonner
npx shadcn add command    # untuk agent selector combobox
npx shadcn add collapsible # untuk tool call view
```

### URL-based Tabs Pattern

Jangan pakai `useState` untuk tabs — pakai URL. Pattern:

```typescript
// ✅ Benar — tab state di URL
const activeTab = tabs.find(t => pathname.startsWith(t.href))?.value

// ❌ Salah — tab state di component
const [activeTab, setActiveTab] = useState('overview')
```

Ini penting agar:
- Refresh tidak reset tab
- URL bisa di-share/bookmark
- Back button browser works

### Chat Streaming

Chat sudah pakai `useChat` dari `@ai-sdk/react` + `POST /api/conversations/:id/chat`.
Tidak ada perubahan di sini — hanya UI wrapper yang dibuat ulang.

### Conversation List — Optimistic Updates

Ketika user send message pertama (new conversation):
1. Optimistically tambah conversation ke list
2. Navigate ke `/chats/[new-conv-id]`
3. Invalidate query `conversations`

---

*Generated: 2026-04-05 | Status: Planning — Ready for Implementation*