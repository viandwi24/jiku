import { Router } from 'express'
import { hash, compare } from 'bcryptjs'
import { getUserByEmail, createUser } from '@jiku-studio/db'
import { signJwt } from '../middleware/auth.ts'
import { authRateLimit } from '../middleware/rate-limit.ts'
import { audit } from '../audit/logger.ts'

const router = Router()

router.post('/register', authRateLimit, async (req, res) => {
  const { email, name, password } = req.body as { email: string; name: string; password: string }

  const existing = await getUserByEmail(email)
  if (existing) {
    res.status(409).json({ error: 'Email already registered' })
    return
  }

  const hashedPassword = await hash(password, 10)
  const user = await createUser({ email, name, password: hashedPassword })

  const token = await signJwt({ user_id: user.id })
  audit.authRegister({ actor_id: user.id, actor_type: 'user', ip_address: req.ip ?? null, user_agent: req.get('user-agent') ?? null }, email)
  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

router.post('/login', authRateLimit, async (req, res) => {
  const { email, password } = req.body as { email: string; password: string }

  const user = await getUserByEmail(email)
  if (!user) {
    audit.authLogin({ actor_id: null, ip_address: req.ip ?? null, user_agent: req.get('user-agent') ?? null }, email, false)
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const valid = await compare(password, user.password)
  if (!valid) {
    audit.authLogin({ actor_id: null, ip_address: req.ip ?? null, user_agent: req.get('user-agent') ?? null }, email, false)
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  audit.authLogin({ actor_id: user.id, ip_address: req.ip ?? null, user_agent: req.get('user-agent') ?? null }, email, true)
  const token = await signJwt({ user_id: user.id })
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

export { router as authRouter }
