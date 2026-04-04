import type { Context, Next } from 'hono'
import { createMiddleware } from 'hono/factory'
import { SignJWT, jwtVerify } from 'jose'
import { env } from '../env.ts'

const secret = new TextEncoder().encode(env.JWT_SECRET)

export async function signJwt(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRES_IN)
    .sign(secret)
}

export async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    return payload as Record<string, unknown>
  } catch {
    return null
  }
}

export const authMiddleware = createMiddleware(async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = authHeader.slice(7)
  const payload = await verifyJwt(token)

  if (!payload || typeof payload.user_id !== 'string') {
    return c.json({ error: 'Invalid token' }, 401)
  }

  c.set('user_id', payload.user_id)
  await next()
})
