'use client'

import { use, useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type AutoReplyRule, type AvailabilitySchedule } from '@/lib/api'
import { Badge, Button, Input, Switch, Separator, cn } from '@jiku/ui'
import { Clock, Inbox, MessageCircleReply, Plus, Trash2, GripVertical } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

const EMPTY_RULE: AutoReplyRule = { trigger: 'exact', pattern: '', response: '', enabled: true }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const DEFAULT_SCHEDULE: AvailabilitySchedule = {
  enabled: false,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  hours: [{ days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }],
  offline_message: 'The agent is currently offline. Please try again later.',
}

export default function AutoReplyPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const queryClient = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
    select: d => d.projects.find(p => p.slug === projectSlug) ?? null,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectData?.id],
    queryFn: () => api.agents.list(projectData!.id),
    enabled: !!projectData?.id,
  })

  const currentAgent = agentsData?.agents.find(a => a.slug === agentSlug)

  // --- Queue Mode ---
  const queueMode = (currentAgent?.queue_mode ?? 'off') as string

  const queueMutation = useMutation({
    mutationFn: (queue_mode: string) => api.agents.update(currentAgent!.id, { queue_mode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', projectData?.id] })
      toast.success('Queue mode saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  // --- Auto-Reply Rules ---
  const [rules, setRules] = useState<AutoReplyRule[]>([])
  const [rulesInitialized, setRulesInitialized] = useState(false)

  useEffect(() => {
    if (currentAgent) {
      setRules((currentAgent.auto_replies ?? []) as AutoReplyRule[])
      setRulesInitialized(true)
    }
  }, [currentAgent?.auto_replies])

  const rulesMutation = useMutation({
    mutationFn: (auto_replies: AutoReplyRule[]) =>
      api.agents.update(currentAgent!.id, { auto_replies }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', projectData?.id] })
      toast.success('Auto-reply rules saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const rulesChanged = rulesInitialized && JSON.stringify(rules) !== JSON.stringify(currentAgent?.auto_replies ?? [])

  function addRule() {
    setRules([...rules, { ...EMPTY_RULE }])
  }

  function updateRule(index: number, field: keyof AutoReplyRule, value: string | boolean) {
    setRules(rules.map((r, i) => i === index ? { ...r, [field]: value } : r))
  }

  function removeRule(index: number) {
    setRules(rules.filter((_, i) => i !== index))
  }

  // --- Availability Schedule ---
  const [schedule, setSchedule] = useState<AvailabilitySchedule>(DEFAULT_SCHEDULE)
  const [scheduleInitialized, setScheduleInitialized] = useState(false)

  useEffect(() => {
    if (currentAgent) {
      setSchedule((currentAgent.availability_schedule as AvailabilitySchedule) ?? DEFAULT_SCHEDULE)
      setScheduleInitialized(true)
    }
  }, [currentAgent?.availability_schedule])

  const scheduleMutation = useMutation({
    mutationFn: (availability_schedule: AvailabilitySchedule) =>
      api.agents.update(currentAgent!.id, { availability_schedule }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', projectData?.id] })
      toast.success('Availability schedule saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const scheduleChanged = scheduleInitialized && JSON.stringify(schedule) !== JSON.stringify(currentAgent?.availability_schedule ?? DEFAULT_SCHEDULE)

  function toggleDay(windowIndex: number, day: number) {
    setSchedule({
      ...schedule,
      hours: schedule.hours.map((w, i) => {
        if (i !== windowIndex) return w
        const days = w.days.includes(day) ? w.days.filter(d => d !== day) : [...w.days, day].sort()
        return { ...w, days }
      }),
    })
  }

  function addWindow() {
    setSchedule({
      ...schedule,
      hours: [...schedule.hours, { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' }],
    })
  }

  function removeWindow(index: number) {
    setSchedule({
      ...schedule,
      hours: schedule.hours.filter((_, i) => i !== index),
    })
  }

  if (!currentAgent) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      {/* Queue Mode */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Inbox className="h-4 w-4" />
            Queue Mode
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            How to handle new messages when the agent is already processing one.
          </p>
        </div>

        <div className="space-y-2">
          {([
            { value: 'off', label: 'Off', desc: 'Reject or drop messages while agent is busy (default)' },
            { value: 'queue', label: 'Queue', desc: 'Buffer messages silently and process them in order' },
            { value: 'ack_queue', label: 'Acknowledge & Queue', desc: 'Send acknowledgment, then queue for processing' },
          ] as const).map(opt => (
            <button
              key={opt.value}
              onClick={() => queueMutation.mutate(opt.value)}
              disabled={queueMutation.isPending}
              className={cn(
                'w-full flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                queueMode === opt.value ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-muted/40',
              )}
            >
              <div className="flex-1">
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-xs text-muted-foreground">{opt.desc}</p>
              </div>
              {queueMode === opt.value && <Badge className="shrink-0 text-[10px]">active</Badge>}
            </button>
          ))}
        </div>
      </section>

      <Separator />

      {/* Auto-Reply Rules */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <MessageCircleReply className="h-4 w-4" />
              Auto-Reply Rules
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Rules evaluated before the LLM. If matched, response is sent instantly without using tokens.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addRule}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Rule
          </Button>
        </div>

        {rules.length === 0 ? (
          <div className="border border-dashed rounded-lg py-8 text-center text-sm text-muted-foreground">
            No auto-reply rules. Click &quot;Add Rule&quot; to create one.
          </div>
        ) : (
          <div className="space-y-3">
            {rules.map((rule, i) => (
              <div key={i} className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <GripVertical className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                  <select
                    value={rule.trigger}
                    onChange={e => updateRule(i, 'trigger', e.target.value)}
                    className="text-sm bg-transparent border rounded px-2 py-1"
                  >
                    <option value="exact">Exact Match</option>
                    <option value="contains">Contains</option>
                    <option value="regex">Regex</option>
                    <option value="command">Command (/...)</option>
                  </select>
                  <div className="flex-1" />
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={val => updateRule(i, 'enabled', val)}
                  />
                  <button
                    onClick={() => removeRule(i)}
                    className="text-muted-foreground hover:text-destructive transition-colors p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">
                      {rule.trigger === 'command' ? 'Command (without /)' : 'Pattern'}
                    </label>
                    <Input
                      value={rule.pattern}
                      onChange={e => updateRule(i, 'pattern', e.target.value)}
                      placeholder={rule.trigger === 'regex' ? '^hello.*' : rule.trigger === 'command' ? 'help' : 'hello'}
                      className="text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Response</label>
                    <Input
                      value={rule.response}
                      onChange={e => updateRule(i, 'response', e.target.value)}
                      placeholder="Auto-reply message..."
                      className="text-sm"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {rulesChanged && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => {
              setRules((currentAgent.auto_replies ?? []) as AutoReplyRule[])
            }}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => rulesMutation.mutate(rules)}
              disabled={rulesMutation.isPending}
            >
              {rulesMutation.isPending ? 'Saving...' : 'Save Rules'}
            </Button>
          </div>
        )}
      </section>

      <Separator />

      {/* Availability Schedule */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Clock className="h-4 w-4" />
            Availability Schedule
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Set hours when the agent is available. Outside these hours, the offline message is sent automatically.
          </p>
        </div>

        <div className="flex items-center justify-between border rounded-lg p-4">
          <div>
            <p className="text-sm font-medium">Enable Schedule</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              When disabled, the agent is available 24/7
            </p>
          </div>
          <Switch
            checked={schedule.enabled}
            onCheckedChange={val => setSchedule({ ...schedule, enabled: val })}
          />
        </div>

        {schedule.enabled && (
          <div className="space-y-4">
            {/* Timezone */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Timezone</label>
              <Input
                value={schedule.timezone}
                onChange={e => setSchedule({ ...schedule, timezone: e.target.value })}
                placeholder="Asia/Jakarta"
                className="text-sm max-w-xs"
              />
            </div>

            {/* Time Windows */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs text-muted-foreground">Active Hours</label>
                <Button variant="outline" size="sm" onClick={addWindow}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add Window
                </Button>
              </div>

              {schedule.hours.map((window, wi) => (
                <div key={wi} className="border rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Window {wi + 1}</span>
                    <div className="flex-1" />
                    {schedule.hours.length > 1 && (
                      <button
                        onClick={() => removeWindow(wi)}
                        className="text-muted-foreground hover:text-destructive transition-colors p-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Days */}
                  <div className="flex gap-1">
                    {DAYS.map((day, di) => (
                      <button
                        key={di}
                        onClick={() => toggleDay(wi, di)}
                        className={cn(
                          'w-9 h-7 rounded text-xs font-medium transition-colors',
                          window.days.includes(di)
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80',
                        )}
                      >
                        {day}
                      </button>
                    ))}
                  </div>

                  {/* Time range */}
                  <div className="flex items-center gap-2">
                    <Input
                      type="time"
                      value={window.from}
                      onChange={e => setSchedule({
                        ...schedule,
                        hours: schedule.hours.map((w, i) => i === wi ? { ...w, from: e.target.value } : w),
                      })}
                      className="text-sm w-32"
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <Input
                      type="time"
                      value={window.to}
                      onChange={e => setSchedule({
                        ...schedule,
                        hours: schedule.hours.map((w, i) => i === wi ? { ...w, to: e.target.value } : w),
                      })}
                      className="text-sm w-32"
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Offline Message */}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Offline Message</label>
              <Input
                value={schedule.offline_message}
                onChange={e => setSchedule({ ...schedule, offline_message: e.target.value })}
                placeholder="The agent is currently offline..."
                className="text-sm"
              />
            </div>
          </div>
        )}

        {scheduleChanged && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => {
              setSchedule((currentAgent.availability_schedule as AvailabilitySchedule) ?? DEFAULT_SCHEDULE)
            }}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => scheduleMutation.mutate(schedule)}
              disabled={scheduleMutation.isPending}
            >
              {scheduleMutation.isPending ? 'Saving...' : 'Save Schedule'}
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}
