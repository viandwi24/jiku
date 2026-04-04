import { Hono } from 'hono'
import { hash, compare } from 'bcryptjs'
import { getUserByEmail, createUser } from '@jiku-studio/db'
import { signJwt } from '../middleware/auth.ts'
import type { AppVariables } from '../types.ts'

const router = new Hono<{ Variables: AppVariables }>()

router.post('/register', async (c) => {
  const body = await c.req.json<{ email: string; name: string; password: string }>()

  const existing = await getUserByEmail(body.email)
  if (existing) {
    return c.json({ error: 'Email already registered' }, 409)
  }

  const hashedPassword = await hash(body.password, 10)
  const user = await createUser({
    email: body.email,
    name: body.name,
    password: hashedPassword,
  })

  const token = await signJwt({ user_id: user.id })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name } }, 201)
})

router.post('/login', async (c) => {
  const body = await c.req.json<{ email: string; password: string }>()

  const user = await getUserByEmail(body.email)
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const valid = await compare(body.password, user.password)
  if (!valid) {
    return c.json({ error: 'Invalid credentials' }, 401)
  }

  const token = await signJwt({ user_id: user.id })
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

export { router as authRouter }
