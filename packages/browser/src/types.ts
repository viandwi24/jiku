import { z } from "zod";

// --- Profile Schemas ---

export const cdpConfigSchema = z.object({
  endpoint: z.string().url().describe("CDP WebSocket URL, e.g. ws://localhost:9222"),
});

export type CdpConfig = z.infer<typeof cdpConfigSchema>;

export const createProfileSchema = z.object({
  id: z.string().min(1),
  type: z.literal("cdp"),
  config: cdpConfigSchema,
});

export type CreateProfileInput = z.infer<typeof createProfileSchema>;

export const updateProfileSchema = z.object({
  config: cdpConfigSchema.partial(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export interface Profile {
  readonly id: string;
  readonly type: "cdp";
  readonly config: CdpConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// --- Command Types ---

export type BrowserCommand =
  // Navigation
  | { action: "open"; url: string }
  | { action: "back" }
  | { action: "forward" }
  | { action: "reload" }
  | { action: "close" }
  // Observation
  | { action: "snapshot"; interactive?: boolean; compact?: boolean; selector?: string; depth?: number }
  | { action: "screenshot"; full?: boolean; annotate?: boolean }
  | { action: "pdf"; path: string }
  | { action: "get"; subcommand: string; ref?: string; attr?: string }
  // Interaction
  | { action: "click"; ref: string; newTab?: boolean }
  | { action: "dblclick"; ref: string }
  | { action: "fill"; ref: string; text: string }
  | { action: "type"; ref: string; text: string }
  | { action: "press"; key: string }
  | { action: "hover"; ref: string }
  | { action: "focus"; ref: string }
  | { action: "check"; ref: string }
  | { action: "uncheck"; ref: string }
  | { action: "select"; ref: string; values: string[] }
  | { action: "drag"; src: string; dst: string }
  | { action: "upload"; ref: string; files: string[] }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right"; pixels?: number }
  | { action: "scrollintoview"; ref: string }
  // Wait
  | { action: "wait"; ref?: string; text?: string; url?: string; ms?: number }
  // Tabs
  | { action: "tab"; operation: "list" }
  | { action: "tab"; operation: "new"; url?: string }
  | { action: "tab"; operation: "close"; index?: number }
  | { action: "tab"; operation: "switch"; index: number }
  // JavaScript
  | { action: "eval"; js: string }
  // Cookies & Storage
  | { action: "cookies"; operation: "get" | "clear" }
  | { action: "cookies"; operation: "set"; cookie: Record<string, unknown> }
  | { action: "storage"; storageType: "local" | "session" }
  // Batch
  | { action: "batch"; commands: string[] };

// --- CLI Output (agent-browser --json) ---

export interface CliOutput<T = unknown> {
  readonly success: boolean;
  readonly data: T | null;
  readonly error: string | null;
}

// Known data shapes returned by agent-browser
export interface NavigateData {
  readonly title: string;
  readonly url: string;
}

export interface SnapshotData {
  readonly origin: string;
  readonly refs: Record<string, { name: string; role: string }>;
  readonly snapshot: string;
}

export interface ScreenshotData {
  readonly base64: string;
  readonly format: "png";
}

export interface GetTitleData {
  readonly title: string;
}

export interface GetUrlData {
  readonly url: string;
}

export interface GetTextData {
  readonly text: string;
}

export interface GetHtmlData {
  readonly html: string;
}

export interface GetValueData {
  readonly value: string;
}

export interface GetAttrData {
  readonly value: string;
}

// --- Parsed Result ---

export interface BrowserResult<T = unknown> {
  readonly success: boolean;
  readonly data: T | null;
  readonly error: string | null;
  readonly hint: string | null;
}

// --- Raw Command Result (internal) ---

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// --- API Response ---

export interface ApiResponse<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

// --- Server Config ---

export interface BrowserAgentServerConfig {
  readonly port?: number;
  readonly host?: string;
  readonly agentBrowserBin?: string;
}
