'use client'

import Link from 'next/link'
import { Building2 } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardDescription } from '@jiku/ui'
import type { Company } from '@/lib/api'

interface CompanyCardProps {
  company: Company
}

export function CompanyCard({ company }: CompanyCardProps) {
  return (
    <Link href={`/${company.slug}`}>
      <Card className="cursor-pointer hover:shadow-md transition-shadow h-full">
        <CardHeader>
          <div className="flex items-center gap-2 mb-1">
            <Building2 className="w-4 h-4 text-muted-foreground" />
          </div>
          <CardTitle className="text-base">{company.name}</CardTitle>
          <CardDescription className="text-xs font-mono">{company.slug}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  )
}
