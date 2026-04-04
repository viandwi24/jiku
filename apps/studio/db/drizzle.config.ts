import { defineConfig } from 'drizzle-kit'
import { resolve } from 'path'

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jiku_studio',
  },
})
