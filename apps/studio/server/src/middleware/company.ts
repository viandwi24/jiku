import type { Context, Next } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getMember, getCompanyById } from '@jiku-studio/db'

export const companyMiddleware = createMiddleware(async (c: Context, next: Next) => {
  const userId = c.get('user_id') as string
  const companyId = c.req.param('cid') ?? c.get('company_id') as string | undefined

  if (!companyId) {
    return c.json({ error: 'Company not specified' }, 400)
  }

  const company = await getCompanyById(companyId)
  if (!company) {
    return c.json({ error: 'Company not found' }, 404)
  }

  const member = await getMember(companyId, userId)
  if (!member) {
    return c.json({ error: 'Not a member of this company' }, 403)
  }

  c.set('company', company)
  c.set('member', member)
  await next()
})
