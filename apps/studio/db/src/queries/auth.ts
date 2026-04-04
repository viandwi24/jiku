import { eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { users } from '../schema/index.ts'
import type { NewUser } from '../schema/index.ts'

export async function getUserByEmail(email: string) {
  return db.query.users.findFirst({
    where: eq(users.email, email),
  })
}

export async function getUserById(id: string) {
  return db.query.users.findFirst({
    where: eq(users.id, id),
  })
}

export async function createUser(data: Omit<NewUser, 'id' | 'created_at'>) {
  const [user] = await db.insert(users).values(data).returning()
  return user!
}
