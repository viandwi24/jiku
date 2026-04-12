import { useState, useEffect } from 'react'
import {
  defineMountable,
  PluginPage,
  PluginSection,
  PluginCard,
  usePluginQuery,
} from '@jiku/kit/ui'
import type { StudioComponentProps } from '@jiku-plugin/studio'

interface Summary {
  project_id: string
  total_events: number
  last_event_at: string | null
}
interface Event { id: string; name: string; at: string; meta?: Record<string, unknown> }

interface Agent { id: string; name: string }

function Dashboard({ ctx }: StudioComponentProps) {
  const summary = usePluginQuery<Summary>(ctx, 'summary')
  const events = usePluginQuery<{ events: Event[] }>(ctx, 'events')
  const [pending, setPending] = useState(false)

  // Demo ctx.studio.api — read agents from the host API.
  const [agents, setAgents] = useState<Agent[] | null>(null)
  useEffect(() => {
    ctx.studio.api
      .get<{ agents: Agent[] }>(`/api/projects/${ctx.project.id}/agents`)
      .then(r => setAgents(r.agents))
      .catch(() => setAgents([]))
  }, [ctx])

  async function handleRecord(name: string) {
    try {
      setPending(true)
      await ctx.api.mutate('events', { name, meta: { via: 'ui' } })
      ctx.ui.toast({ title: 'Event recorded', description: name, variant: 'success' })
      await Promise.all([summary.refetch(), events.refetch()])
    } catch (err) {
      ctx.ui.toast({
        title: 'Failed to record event',
        description: err instanceof Error ? err.message : String(err),
        variant: 'error',
      })
    } finally {
      setPending(false)
    }
  }

  async function handleInvokeTool() {
    try {
      await ctx.tools.invoke('jiku.analytics:analytics_record', { name: 'tool_invoke_demo' })
      ctx.ui.toast({ title: 'Recorded via tool invoke', variant: 'success' })
      await Promise.all([summary.refetch(), events.refetch()])
    } catch (err) {
      ctx.ui.toast({
        title: 'Tool invoke failed',
        description: err instanceof Error ? err.message : String(err),
        variant: 'error',
      })
    }
  }

  return (
    <PluginPage
      title="Analytics"
      description={`Project ${ctx.project.slug} · plugin ${ctx.plugin.id} v${ctx.plugin.version}`}
      actions={
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => handleRecord('demo_click')}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Record "demo_click"
          </button>
          <button
            type="button"
            onClick={handleInvokeTool}
            className="rounded border px-3 py-1.5 text-xs hover:bg-accent"
          >
            Invoke tool
          </button>
        </>
      }
    >
      <PluginSection title="Overview">
        <div className="grid gap-3 md:grid-cols-3">
          <PluginCard>
            <div className="text-xs text-muted-foreground">Project</div>
            <div className="mt-1 font-mono text-sm">{ctx.project.slug}</div>
          </PluginCard>
          <PluginCard>
            <div className="text-xs text-muted-foreground">Total events</div>
            <div className="mt-1 text-2xl font-semibold">
              {summary.isLoading ? '…' : summary.data?.total_events ?? 0}
            </div>
          </PluginCard>
          <PluginCard>
            <div className="text-xs text-muted-foreground">Last event</div>
            <div className="mt-1 text-xs">{summary.data?.last_event_at ?? '—'}</div>
          </PluginCard>
        </div>
      </PluginSection>

      <PluginSection title="Host data via ctx.studio.api" description="Agents for this project, fetched through the generic Studio API passthrough.">
        {agents === null ? (
          <p className="text-sm text-muted-foreground">Loading agents…</p>
        ) : agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents (or access denied).</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {agents.map(a => (
              <li key={a.id} className="rounded border p-2 text-xs font-mono">
                <span className="font-medium">{a.name}</span>
                <span className="ml-2 text-muted-foreground">{a.id}</span>
              </li>
            ))}
          </ul>
        )}
      </PluginSection>

      <PluginSection title="Recent events">
        {events.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (events.data?.events.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No events yet. Click "Record &quot;demo_click&quot;" to add one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {events.data?.events.slice().reverse().map(e => (
              <li key={e.id} className="flex items-center justify-between rounded border p-2 text-xs font-mono">
                <span className="font-medium">{e.name}</span>
                <time className="text-muted-foreground">{e.at}</time>
              </li>
            ))}
          </ul>
        )}
      </PluginSection>
    </PluginPage>
  )
}

export default defineMountable(Dashboard)
