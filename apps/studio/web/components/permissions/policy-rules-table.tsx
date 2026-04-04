'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { PolicyRule } from '@/lib/api'
import { Badge } from '@jiku/ui'
import { Button } from '@jiku/ui'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'

interface PolicyRulesTableProps {
  policyId: string
  rules: PolicyRule[]
}

export function PolicyRulesTable({ policyId, rules }: PolicyRulesTableProps) {
  const qc = useQueryClient()

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) => api.policies.deleteRule(policyId, ruleId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['policy-rules', policyId] })
      toast.success('Rule deleted')
    },
  })

  return (
    <div className="rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Resource</th>
            <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Subject</th>
            <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Effect</th>
            <th className="px-4 py-2.5 w-12" />
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">No rules configured</td>
            </tr>
          ) : (
            rules.map(rule => (
              <tr key={rule.id} className="border-b last:border-0">
                <td className="px-4 py-2.5">
                  <div className="font-mono text-xs">{rule.resource_id}</div>
                  <div className="text-xs text-muted-foreground">{rule.resource_type}</div>
                </td>
                <td className="px-4 py-2.5">
                  {rule.subject === '*' ? (
                    <span className="text-xs text-muted-foreground">* (everyone)</span>
                  ) : (
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {rule.subject_type}:{rule.subject}
                    </code>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={rule.effect === 'allow' ? 'default' : 'destructive'} className="text-xs">
                    {rule.effect}
                  </Badge>
                </td>
                <td className="px-4 py-2.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => deleteRule.mutate(rule.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
