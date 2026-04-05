'use client'

import Link from 'next/link'
import { FolderOpen } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardDescription } from '@jiku/ui'
import type { Project } from '@/lib/api'

interface ProjectCardProps {
  project: Project
  companySlug: string
}

export function ProjectCard({ project, companySlug }: ProjectCardProps) {
  return (
    <Link href={`/studio/companies/${companySlug}/projects/${project.slug}`}>
      <Card className="cursor-pointer hover:shadow-md transition-shadow h-full">
        <CardHeader>
          <div className="mb-1">
            <FolderOpen className="w-4 h-4 text-muted-foreground" />
          </div>
          <CardTitle className="text-base">{project.name}</CardTitle>
          <CardDescription className="text-xs font-mono">{project.slug}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  )
}
