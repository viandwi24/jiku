import type { Company, CompanyMember } from '@jiku-studio/db'

export type AppVariables = {
  user_id: string
  company: Company
  member: CompanyMember
  company_id: string
}
