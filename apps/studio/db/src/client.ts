import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import * as schema from './schema/index.ts'

const connectionString = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jiku_studio'

const sql = postgres(connectionString)

export const db = drizzle(sql, { schema })

export type DbClient = typeof db

export async function checkDbConnection(): Promise<void> {
  try {
    await sql`SELECT 1`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[jiku] Cannot connect to database: ${msg}`)
    process.exit(1)
  }
}

export async function runMigrations(): Promise<void> {
  const migrationsFolder = resolve(fileURLToPath(import.meta.url), '../../migrations')
  console.log('[jiku] Running migrations from', migrationsFolder)
  await migrate(db, { migrationsFolder })
  console.log('[jiku] Migrations complete')
}
