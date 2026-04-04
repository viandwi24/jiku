export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/jiku_studio',
  JWT_SECRET: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '7d',
  PORT: Number(process.env.PORT ?? 3001),
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
}
