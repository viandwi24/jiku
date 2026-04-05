'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { CompanyCard } from '@/components/company/company-card'
import { CreateCompanyDialog } from '@/components/company/create-company-dialog'
import { Skeleton, Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '@jiku/ui'
import { Building2 } from 'lucide-react'

export default function CompaniesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Companies</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage your companies</p>
        </div>
        <CreateCompanyDialog />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] rounded-lg" />
          ))}
        </div>
      ) : data?.companies.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon"><Building2 /></EmptyMedia>
          <EmptyTitle>No companies yet</EmptyTitle>
          <EmptyDescription>Create your first company to get started</EmptyDescription>
          <EmptyContent><CreateCompanyDialog /></EmptyContent>
        </Empty>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {data?.companies.map(company => (
            <CompanyCard key={company.id} company={company} />
          ))}
        </div>
      )}
    </div>
  )
}
