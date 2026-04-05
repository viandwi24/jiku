import { redirect } from 'next/navigation'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default async function AgentSettingsPermissionsRedirect({ params }: PageProps) {
  const { company, project, agent } = await params
  redirect(`/studio/companies/${company}/projects/${project}/agents/${agent}/permissions`)
}
