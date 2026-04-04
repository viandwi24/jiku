import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16

function getKey(): Buffer {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!key) throw new Error('CREDENTIALS_ENCRYPTION_KEY not set in env')
  const buf = Buffer.from(key, 'hex')
  if (buf.length !== 32) throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)')
  return buf
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Format: iv.tag.encrypted (all base64)
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.')
}

export function decrypt(ciphertext: string): string {
  const key = getKey()
  const [ivB64, tagB64, encB64] = ciphertext.split('.')

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64!, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'))

  return Buffer.concat([
    decipher.update(Buffer.from(encB64!, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function encryptFields(fields: Record<string, string>): string {
  return encrypt(JSON.stringify(fields))
}

export function decryptFields(encrypted: string): Record<string, string> {
  return JSON.parse(decrypt(encrypted)) as Record<string, string>
}

export function maskFields(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      v.length > 8 ? `${v.slice(0, 3)}...${v.slice(-4)}` : '••••',
    ])
  )
}
