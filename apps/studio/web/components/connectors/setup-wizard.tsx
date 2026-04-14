'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Spinner,
} from '@jiku/ui'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import type {
  ConnectorSetupSpec,
  ConnectorSetupStep,
  ConnectorSetupStepInputValue,
  ConnectorSetupStepResult,
} from '@/lib/api'

interface SetupWizardProps {
  projectId: string
  credentialId: string
  adapterId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete: (result: { fields: Record<string, unknown>; ui_message?: string }) => void
  onCancel?: () => void
}

type PhaseState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'running' }
  | { kind: 'submitting' }
  | { kind: 'completed'; message?: string }
  | { kind: 'aborted'; message: string; reason?: string }

interface StepError {
  message: string
  hint?: string
  retry_count?: number
  max_retries?: number
}

function pickNextLabel(step: ConnectorSetupStep): string {
  // Heuristic label based on step title keywords. Generic fallback is "Continue".
  const t = step.title.toLowerCase()
  if (t.includes('verify') || t.includes('code') || t.includes('otp')) return 'Verify'
  if (t.includes('send')) return 'Send Code'
  if (t.includes('confirm')) return 'Confirm'
  return 'Continue'
}

function defaultValueFor(type: 'string' | 'number' | 'boolean'): ConnectorSetupStepInputValue {
  if (type === 'boolean') return false
  if (type === 'number') return ''
  return ''
}

export function ConnectorSetupWizard({
  projectId,
  credentialId,
  adapterId: _adapterId,
  open,
  onOpenChange,
  onComplete,
  onCancel,
}: SetupWizardProps) {
  const [spec, setSpec] = useState<ConnectorSetupSpec | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [maxRetriesPerStep, setMaxRetriesPerStep] = useState<number>(3)
  const [currentStepId, setCurrentStepId] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const [phase, setPhase] = useState<PhaseState>({ kind: 'loading' })
  const [values, setValues] = useState<Record<string, ConnectorSetupStepInputValue>>({})
  const [stepError, setStepError] = useState<StepError | null>(null)
  // Raw string buffers for number inputs (to let user type freely)
  const [rawNumbers, setRawNumbers] = useState<Record<string, string>>({})
  const startedRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const completedRef = useRef(false)

  const currentStep: ConnectorSetupStep | null = useMemo(() => {
    if (!spec || !currentStepId) return null
    return spec.steps.find(s => s.id === currentStepId) ?? null
  }, [spec, currentStepId])

  const visibleSteps = useMemo(() => (spec ? spec.steps : []), [spec])
  const stepIndex = currentStep ? visibleSteps.findIndex(s => s.id === currentStep.id) : -1
  const totalSteps = visibleSteps.length

  const resetState = useCallback(() => {
    setSpec(null)
    setSessionId(null)
    sessionIdRef.current = null
    setCurrentStepId(null)
    setHistory([])
    setPhase({ kind: 'loading' })
    setValues({})
    setStepError(null)
    setRawNumbers({})
    startedRef.current = false
    completedRef.current = false
  }, [])

  // Initialize values for current step when it changes
  useEffect(() => {
    if (!currentStep) return
    setValues(prev => {
      const next: Record<string, ConnectorSetupStepInputValue> = { ...prev }
      for (const input of currentStep.inputs) {
        if (next[input.name] === undefined) next[input.name] = defaultValueFor(input.type)
      }
      return next
    })
  }, [currentStep])

  // Start session when opened
  useEffect(() => {
    if (!open) return
    if (startedRef.current) return
    startedRef.current = true
    resetState()
    startedRef.current = true
    setPhase({ kind: 'loading' })
    api.connectorSetup
      .start(projectId, credentialId)
      .then(res => {
        setSpec(res.spec)
        setSessionId(res.setup_session_id)
        sessionIdRef.current = res.setup_session_id
        setMaxRetriesPerStep(res.max_retries_per_step)
        setCurrentStepId(res.first_step_id)
        setHistory([res.first_step_id])
        setPhase({ kind: 'running' })
      })
      .catch((err: unknown) => {
        setPhase({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to start setup',
        })
      })
  }, [open, projectId, credentialId, resetState])

  // Cancel session on unmount / dialog close (fire-and-forget)
  const cancelServerSession = useCallback(() => {
    const sid = sessionIdRef.current
    if (!sid) return
    sessionIdRef.current = null
    api.connectorSetup.cancel(projectId, credentialId, sid).catch(() => {
      // best-effort cleanup
    })
  }, [projectId, credentialId])

  const handleClose = useCallback(
    (reason: 'user-cancel' | 'completed') => {
      if (reason === 'user-cancel' && !completedRef.current) {
        cancelServerSession()
        onCancel?.()
      }
      onOpenChange(false)
      // Defer reset so exit animations can complete
      setTimeout(() => {
        if (!open) resetState()
      }, 0)
    },
    [cancelServerSession, onCancel, onOpenChange, open, resetState]
  )

  useEffect(() => {
    return () => {
      // On real unmount (nav away), try to clean up session
      if (sessionIdRef.current && !completedRef.current) {
        cancelServerSession()
      }
    }
  }, [cancelServerSession])

  const handleDialogOpenChange = (next: boolean) => {
    if (!next) handleClose('user-cancel')
    else onOpenChange(true)
  }

  const goBack = () => {
    if (history.length <= 1) return
    const next = history.slice(0, -1)
    setHistory(next)
    setCurrentStepId(next[next.length - 1] ?? null)
    setStepError(null)
  }

  const submitStep = async () => {
    if (!currentStep || !sessionId) return
    // Validate required + coerce number
    const input: Record<string, ConnectorSetupStepInputValue> = {}
    for (const field of currentStep.inputs) {
      const v = values[field.name]
      if (field.type === 'number') {
        const raw = rawNumbers[field.name] ?? (typeof v === 'number' ? String(v) : '')
        if (raw === '' || raw === undefined) {
          if (field.required) {
            setStepError({ message: `${field.label} is required` })
            return
          }
          continue
        }
        const parsed = Number(raw)
        if (Number.isNaN(parsed)) {
          setStepError({ message: `${field.label} must be a number` })
          return
        }
        input[field.name] = parsed
      } else if (field.type === 'boolean') {
        input[field.name] = Boolean(v)
      } else {
        const s = typeof v === 'string' ? v : ''
        if (field.required && s.trim() === '') {
          setStepError({ message: `${field.label} is required` })
          return
        }
        input[field.name] = s
      }
    }

    setPhase({ kind: 'submitting' })
    setStepError(null)
    try {
      const res: ConnectorSetupStepResult = await api.connectorSetup.step(
        projectId,
        credentialId,
        sessionId,
        { step_id: currentStep.id, input }
      )

      if (res.ok && 'complete' in res && res.complete) {
        completedRef.current = true
        setPhase({ kind: 'completed', message: res.ui_message })
        onComplete({ fields: res.fields, ui_message: res.ui_message })
        return
      }

      if (res.ok) {
        const nextId = 'next_step' in res ? res.next_step : undefined
        if (!nextId) {
          // No next step and not complete → treat as completed without fields
          setPhase({ kind: 'completed', message: res.ui_message })
          return
        }
        // Clear values that don't exist in next step
        setValues({})
        setRawNumbers({})
        setHistory(h => [...h, nextId])
        setCurrentStepId(nextId)
        setPhase({ kind: 'running' })
        return
      }

      // ok: false
      if (res.aborted) {
        setPhase({
          kind: 'aborted',
          message: res.error,
          reason: res.reason,
        })
        return
      }

      setStepError({
        message: res.error,
        hint: res.hint,
        retry_count: res.retry_count,
        max_retries: res.max_retries,
      })
      if (res.retry_step && res.retry_step !== currentStep.id) {
        setHistory(h => [...h, res.retry_step as string])
        setCurrentStepId(res.retry_step)
      }
      setPhase({ kind: 'running' })
    } catch (err: unknown) {
      setStepError({
        message: err instanceof Error ? err.message : 'Request failed',
      })
      setPhase({ kind: 'running' })
    }
  }

  const renderInputs = () => {
    if (!currentStep) return null
    return (
      <div className="space-y-4">
        {currentStep.description && (
          <p className="text-sm text-muted-foreground">{currentStep.description}</p>
        )}
        {currentStep.inputs.map(field => {
          const id = `setup-input-${field.name}`
          if (field.type === 'boolean') {
            return (
              <div key={field.name} className="flex items-start gap-2">
                <Checkbox
                  id={id}
                  checked={Boolean(values[field.name])}
                  onCheckedChange={checked =>
                    setValues(prev => ({ ...prev, [field.name]: Boolean(checked) }))
                  }
                />
                <div className="space-y-1">
                  <Label htmlFor={id} className="cursor-pointer">
                    {field.label}
                    {field.required && <span className="text-destructive ml-1">*</span>}
                  </Label>
                  {field.description && (
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                  )}
                </div>
              </div>
            )
          }
          const isSecret = field.secret === true
          const isNumber = field.type === 'number'
          return (
            <div key={field.name} className="space-y-2">
              <Label htmlFor={id}>
                {field.label}
                {field.required && <span className="text-destructive ml-1">*</span>}
              </Label>
              <Input
                id={id}
                type={isSecret ? 'password' : isNumber ? 'number' : 'text'}
                value={
                  isNumber
                    ? rawNumbers[field.name] ?? (typeof values[field.name] === 'number' ? String(values[field.name]) : '')
                    : typeof values[field.name] === 'string'
                      ? (values[field.name] as string)
                      : ''
                }
                placeholder={field.placeholder ?? ''}
                onChange={e => {
                  const raw = e.target.value
                  if (isNumber) {
                    setRawNumbers(prev => ({ ...prev, [field.name]: raw }))
                  } else {
                    setValues(prev => ({ ...prev, [field.name]: raw }))
                  }
                }}
                required={field.required}
              />
              {field.description && (
                <p className="text-xs text-muted-foreground">{field.description}</p>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const title = spec?.title ?? 'Connector Setup'
  const isSubmitting = phase.kind === 'submitting'
  const isLoading = phase.kind === 'loading'

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {spec?.intro && stepIndex <= 0 && phase.kind === 'running' && (
            <DialogDescription>{spec.intro}</DialogDescription>
          )}
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-8 gap-2 text-sm text-muted-foreground">
            <Spinner /> Preparing setup...
          </div>
        )}

        {phase.kind === 'error' && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Failed to start setup</AlertTitle>
            <AlertDescription>{phase.message}</AlertDescription>
          </Alert>
        )}

        {phase.kind === 'aborted' && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Setup aborted</AlertTitle>
            <AlertDescription>
              {phase.message}
              {phase.reason === 'retry_cap_exceeded' && (
                <p className="mt-1 text-xs">Max retries exceeded. Please restart the setup.</p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {phase.kind === 'completed' && (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>Setup complete</AlertTitle>
            <AlertDescription>
              {phase.message ?? 'Credential has been configured.'}
            </AlertDescription>
          </Alert>
        )}

        {(phase.kind === 'running' || phase.kind === 'submitting') && currentStep && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Step {stepIndex + 1} of {totalSteps}
              </span>
              <span className="font-medium text-foreground">{currentStep.title}</span>
            </div>

            {stepError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>
                  {stepError.message}
                  {typeof stepError.retry_count === 'number' &&
                    typeof stepError.max_retries === 'number' && (
                      <span className="ml-2 text-xs font-normal">
                        Attempt {stepError.retry_count} of {stepError.max_retries}
                      </span>
                    )}
                </AlertTitle>
                {stepError.hint && <AlertDescription>{stepError.hint}</AlertDescription>}
              </Alert>
            )}

            {renderInputs()}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {phase.kind === 'completed' || phase.kind === 'aborted' || phase.kind === 'error' ? (
            <Button
              onClick={() =>
                handleClose(phase.kind === 'completed' ? 'completed' : 'user-cancel')
              }
            >
              Close
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleClose('user-cancel')}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={goBack}
                disabled={isSubmitting || history.length <= 1}
              >
                Back
              </Button>
              <Button
                type="button"
                onClick={submitStep}
                disabled={isSubmitting || isLoading || !currentStep}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" /> Submitting...
                  </>
                ) : currentStep ? (
                  pickNextLabel(currentStep)
                ) : (
                  'Continue'
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
