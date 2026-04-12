import rateLimit, { type Options } from 'express-rate-limit'
import type { Request, Response } from 'express'

function userOrIp(req: Request, res: Response): string {
  const userId = res.locals['user_id'] as string | undefined
  return userId ?? req.ip ?? 'anonymous'
}

function ipOnly(req: Request): string {
  return req.ip ?? 'anonymous'
}

function jsonHandler(message: string) {
  return (req: Request, res: Response) => {
    const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit
    const retryAfter = info?.resetTime
      ? Math.ceil((info.resetTime.getTime() - Date.now()) / 1000)
      : undefined
    res.status(429).json({ error: message, retry_after: retryAfter })
  }
}

const common: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
}

// Layer 1 — global default
export const globalRateLimit = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: userOrIp,
  handler: jsonHandler('Too many requests'),
})

// Layer 2 — chat (expensive, hits LLM)
export const chatRateLimit = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: userOrIp,
  handler: jsonHandler('Chat rate limit exceeded. Please wait before sending another message.'),
})

// Layer 3 — auth login/register (brute force protection; NOT applied to /me)
export const authRateLimit = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: ipOnly,
  handler: jsonHandler('Too many authentication attempts. Please try again later.'),
})

// Layer 4 — credentials/secrets
// Covers list + adapters + decrypt. List endpoints are cheap but called by many
// UI tabs simultaneously (agent LLM, memory config, filesystem, disk, channels),
// so the cap is set high. Truly expensive decrypt paths are additionally guarded
// per-credential at the adapter layer.
export const credentialRateLimit = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: userOrIp,
  handler: jsonHandler('Credential operation rate limit exceeded.'),
})

// Layer 5 — file upload
export const uploadRateLimit = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: userOrIp,
  handler: jsonHandler('Upload rate limit exceeded.'),
})
