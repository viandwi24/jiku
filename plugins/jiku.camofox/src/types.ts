import { z } from 'zod'

// CamoFox is a Firefox-based browser with anti-fingerprinting that exposes
// its own REST API (not CDP) at port 9377 by default. See:
//   https://github.com/jo-inc/camofox-browser
//
// Session model:
//   userId     — top-level session owner. One userId per profile.
//   sessionKey — logical grouping within a userId. One sessionKey per agent.
//   tabId      — opaque string returned by POST /tabs. One per agent tab.

export const CamofoxConfigSchema = z.object({
  base_url: z.string()
    .describe('CamoFox server base URL (e.g. http://localhost:9377 or http://camofox:9377 in Docker).')
    .default('http://localhost:9377'),

  api_key: z.string().optional()
    .describe('Bearer token for Authorization header. Set if CamoFox was started with CAMOFOX_API_KEY.'),

  user_id: z.string().optional()
    .describe('CamoFox userId for this profile. Leave blank to use the profile ID automatically.'),

  timeout_ms: z.number().int()
    .min(1000).max(120_000)
    .describe('Per-request timeout in milliseconds. Range: 1000 – 120000.')
    .default(30_000),

  screenshot_as_attachment: z.boolean()
    .describe('Persist screenshots to S3 as attachments. When off, screenshots are returned inline as base64.')
    .default(true),

  preview_url: z.string()
    .describe('Landing URL opened in the Live Preview tab. CamoFox only allows http/https — about:blank is rejected.')
    .default('https://www.example.com'),

  // Informational — mirrors server-side CamoFox env vars. Studio does NOT
  // configure the CamoFox daemon, these are shown as reminders of what the
  // deployed container was started with.
  proxy_host: z.string().optional()
    .describe('Upstream proxy host (set via PROXY_HOST on the CamoFox container). Informational only.'),
  proxy_port: z.number().int().optional()
    .describe('Upstream proxy port (PROXY_PORT). Informational only.'),
})

export type CamofoxConfig = z.infer<typeof CamofoxConfigSchema>
