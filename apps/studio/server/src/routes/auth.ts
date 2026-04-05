import { Router } from 'express'
import { hash, compare } from 'bcryptjs'
import { getUserByEmail, createUser } from '@jiku-studio/db'
import { signJwt } from '../middleware/auth.ts'

const router = Router()

router.post('/register', async (req, res) => {
  const { email, name, password } = req.body as { email: string; name: string; password: string }

  const existing = await getUserByEmail(email)
  if (existing) {
    res.status(409).json({ error: 'Email already registered' })
    return
  }

  const hashedPassword = await hash(password, 10)
  const user = await createUser({ email, name, password: hashedPassword })

  const token = await signJwt({ user_id: user.id })
  res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

router.post('/login', async (req, res) => {
  const { email, password } = req.body as { email: string; password: string }

  const user = await getUserByEmail(email)
  if (!user) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const valid = await compare(password, user.password)
  if (!valid) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const token = await signJwt({ user_id: user.id })
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } })
})

export { router as authRouter }
