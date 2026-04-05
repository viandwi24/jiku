import { redirect } from 'next/navigation'

interface PageProps {
  params: Promise<{ company: string }>
}

export default async function CompanySettingsIndex({ params }: PageProps) {
  const { company } = await params
  redirect(`/studio/companies/${company}/settings/general`)
}
