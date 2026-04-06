import { Router } from 'express'
import type { ProjectGrant } from '@jiku/types'
import {
  getUserByEmail,
  getUserById,
  listCompanyInvitations,
  listPendingInvitationsForEmail,
  getInvitationById,
  createInvitation,
  updateInvitationStatus,
  cancelInvitation,
  createProjectMembership,
  getProjectMembership,
  getProjectRoleById,
  addMember as addCompanyMember,
  getMember as getCompanyMember,
  getSystemRoleByName,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'

const router = Router()
router.use(authMiddleware)

// ─── User-side: view and respond to pending invites ───────────────────────────

/** GET /api/auth/invitations — list pending invitations for current user */
router.get('/auth/invitations', async (_req, res) => {
  const userId = res.locals['user_id'] as string
  const user = await getUserById(userId)
  if (!user) { res.status(404).json({ error: 'User not found' }); return }

  const pending = await listPendingInvitationsForEmail(user.email)
  res.json({ invitations: pending })
})

/** POST /api/auth/invitations/:id/accept */
router.post('/auth/invitations/:id/accept', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const invitation = await getInvitationById(req.params['id']!)

  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return }
  if (invitation.status !== 'pending') {
    res.status(400).json({ error: `Invitation is already ${invitation.status}` })
    return
  }

  // Expired check
  if (new Date() > invitation.expires_at) {
    await updateInvitationStatus(invitation.id, 'expired')
    res.status(400).json({ error: 'Invitation has expired' })
    return
  }

  // Add to company if not already a member
  const existing = await getCompanyMember(invitation.company_id, userId)
  if (!existing) {
    // Find default company role (Member)
    const memberRole = await getSystemRoleByName(invitation.company_id, 'Member')
    if (memberRole) {
      await addCompanyMember(invitation.company_id, userId, memberRole.id)
    }
  }

  // Process project grants
  const grants = (invitation.project_grants ?? []) as ProjectGrant[]
  for (const grant of grants) {
    const alreadyMember = await getProjectMembership(grant.project_id, userId)
    if (!alreadyMember) {
      // Only validate role if one was specified
      const role = grant.role_id ? await getProjectRoleById(grant.role_id) : null
      await createProjectMembership({
        project_id: grant.project_id,
        user_id: userId,
        role_id: role ? grant.role_id : null,
        is_superadmin: false,
        agent_restrictions: {},
        tool_restrictions: {},
      })
    }
  }

  await updateInvitationStatus(invitation.id, 'accepted', userId)
  res.json({ ok: true })
})

/** POST /api/auth/invitations/:id/decline */
router.post('/auth/invitations/:id/decline', async (req, res) => {
  const invitation = await getInvitationById(req.params['id']!)
  if (!invitation) { res.status(404).json({ error: 'Invitation not found' }); return }
  if (invitation.status !== 'pending') {
    res.status(400).json({ error: `Invitation is already ${invitation.status}` })
    return
  }

  await updateInvitationStatus(invitation.id, 'declined')
  res.json({ ok: true })
})

// ─── Admin-side: send and manage company invitations ─────────────────────────

/** GET /api/companies/:cid/invitations */
router.get('/companies/:cid/invitations', async (req, res) => {
  const companyId = req.params['cid']!
  const userId = res.locals['user_id'] as string

  // Only company members can see invitations
  const membership = await getCompanyMember(companyId, userId)
  if (!membership) { res.status(403).json({ error: 'Not a company member' }); return }

  const all = await listCompanyInvitations(companyId)
  res.json({ invitations: all })
})

/** POST /api/companies/:cid/invitations — send invite */
router.post('/companies/:cid/invitations', async (req, res) => {
  const companyId = req.params['cid']!
  const userId = res.locals['user_id'] as string

  // Require company membership
  const membership = await getCompanyMember(companyId, userId)
  if (!membership) { res.status(403).json({ error: 'Not a company member' }); return }

  const { email, project_grants } = req.body as {
    email: string
    project_grants: ProjectGrant[]
  }

  if (!email) { res.status(400).json({ error: 'Email is required' }); return }

  // 7-day expiry
  const expires_at = new Date()
  expires_at.setDate(expires_at.getDate() + 7)

  const invitation = await createInvitation({
    company_id: companyId,
    email: email.toLowerCase().trim(),
    project_grants: project_grants ?? [],
    status: 'pending',
    invited_by: userId,
    expires_at,
  })

  res.status(201).json({ invitation })
})

/** DELETE /api/companies/:cid/invitations/:iid — cancel invite */
router.delete('/companies/:cid/invitations/:iid', async (req, res) => {
  const { cid, iid } = req.params as { cid: string; iid: string }
  const userId = res.locals['user_id'] as string

  const membership = await getCompanyMember(cid, userId)
  if (!membership) { res.status(403).json({ error: 'Not a company member' }); return }

  const invitation = await getInvitationById(iid)
  if (!invitation || invitation.company_id !== cid) {
    res.status(404).json({ error: 'Invitation not found' })
    return
  }

  if (invitation.status !== 'pending') {
    res.status(400).json({ error: `Cannot cancel a ${invitation.status} invitation` })
    return
  }

  await cancelInvitation(iid)
  res.json({ ok: true })
})

export { router as aclInvitationsRouter }
