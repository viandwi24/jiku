'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import { CompanyCard } from '@/components/company/company-card'
import { CreateCompanyDialog } from '@/components/company/create-company-dialog'
import { Skeleton } from '@jiku/ui'

export default function HomePage() {
  const user = useAuthStore(s => s.user)

  const { data, isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
  })

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Welcome, {user?.name ?? 'there'}</h1>
        <p className="text-muted-foreground text-sm mt-1">Select a company to get started</p>
      </div>

      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Your Companies
      </h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {isLoading
          ? Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] rounded-lg" />
          ))
          : data?.companies.map(company => (
            <CompanyCard key={company.id} company={company} />
          ))}
        <CreateCompanyDialog />
      </div>
    </div>
  )
}
