import { hash } from 'bcryptjs'
import { db, eq, users, getUserByEmail } from '@jiku-studio/db'

const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.<>?/~'
const ALPHABET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' + SYMBOLS

function generatePassword(length = 8): string {
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

function prompt(question: string): Promise<string> {
  process.stdout.write(question)
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.off('data', onData)
      process.stdin.pause()
      resolve(chunk.toString().trim())
    }
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

async function main() {
  const email = await prompt('Email: ')
  if (!email) {
    console.error('Email is required.')
    process.exit(1)
  }

  const user = await getUserByEmail(email)
  if (!user) {
    console.error(`No account found for "${email}".`)
    process.exit(1)
  }

  console.log(`Found user: ${user.name} <${user.email}> (id: ${user.id})`)
  const confirm = await prompt('Reset this user\'s password? (y/N): ')
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('Aborted.')
    process.exit(0)
  }

  const newPassword = generatePassword(8)
  const hashed = await hash(newPassword, 10)
  await db.update(users).set({ password: hashed }).where(eq(users.id, user.id))

  console.log('')
  console.log('Password reset successfully.')
  console.log(`Email:        ${user.email}`)
  console.log(`New password: ${newPassword}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
