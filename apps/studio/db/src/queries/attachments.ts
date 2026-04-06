import { db } from '../client.ts'
import { project_attachments } from '../schema/attachments.ts'
import { eq, and, desc } from 'drizzle-orm'
import type { NewProjectAttachment, ProjectAttachment } from '../schema/attachments.ts'

export async function createAttachment(data: NewProjectAttachment): Promise<ProjectAttachment> {
  const [row] = await db.insert(project_attachments).values(data).returning()
  if (!row) throw new Error('Failed to create attachment record')
  return row
}

export async function getAttachmentById(id: string): Promise<ProjectAttachment | null> {
  const [row] = await db.select().from(project_attachments).where(eq(project_attachments.id, id))
  return row ?? null
}

export async function listAttachmentsByProject(
  projectId: string,
  opts?: { limit?: number; offset?: number }
): Promise<ProjectAttachment[]> {
  return db
    .select()
    .from(project_attachments)
    .where(eq(project_attachments.project_id, projectId))
    .orderBy(desc(project_attachments.created_at))
    .limit(opts?.limit ?? 50)
    .offset(opts?.offset ?? 0)
}

export async function listAttachmentsByConversation(conversationId: string): Promise<ProjectAttachment[]> {
  return db
    .select()
    .from(project_attachments)
    .where(eq(project_attachments.conversation_id, conversationId))
    .orderBy(desc(project_attachments.created_at))
}

export async function deleteAttachment(id: string): Promise<void> {
  await db.delete(project_attachments).where(eq(project_attachments.id, id))
}

export async function deleteAttachmentsByConversation(conversationId: string): Promise<number> {
  const rows = await db
    .delete(project_attachments)
    .where(eq(project_attachments.conversation_id, conversationId))
    .returning({ id: project_attachments.id })
  return rows.length
}
