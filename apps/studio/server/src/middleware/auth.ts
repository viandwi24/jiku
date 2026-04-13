import type { Request, Response, NextFunction } from 'express'
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

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  let token: string | null = null
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else if (typeof req.query['token'] === 'string') {
    // SSE / browser-initiated requests can't set custom headers — accept ?token=
    token = req.query['token']
  }
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const payload = await verifyJwt(token)
  if (!payload || typeof payload.user_id !== 'string') {
    res.status(401).json({ error: 'Invalid token' })
    return
  }

  res.locals['user_id'] = payload.user_id
  next()
}
