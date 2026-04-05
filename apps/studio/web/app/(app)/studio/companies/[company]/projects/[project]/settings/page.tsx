import { redirect } from 'next/navigation'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default async function ProjectSettingsIndex({ params }: PageProps) {
  const { company, project } = await params
  redirect(`/studio/companies/${company}/projects/${project}/settings/general`)
}
