import express, { type Request, type Response, type NextFunction } from "express";
import { ZodError } from "zod";
import { ProfileManager, ProfileError } from "./profile-manager.ts";
import { execBrowserCommand } from "./spawner.ts";
import {
  createProfileSchema,
  updateProfileSchema,
  type ApiResponse,
  type BrowserAgentServerConfig,
  type BrowserCommand,
} from "./types.ts";

function param(req: Request, name: string): string {
  const val = req.params[name];
  if (Array.isArray(val)) return val[0]!;
  return val!;
}

export class BrowserAgentServer {
  private readonly app = express();
  private readonly profiles = new ProfileManager();
  private readonly config: Required<BrowserAgentServerConfig>;

  constructor(config?: BrowserAgentServerConfig) {
    this.config = {
      port: config?.port ?? 4100,
      host: config?.host ?? "0.0.0.0",
      agentBrowserBin: config?.agentBrowserBin ?? "",
    };

    this.app.use(express.json());
    this.setupRoutes();
    this.setupErrorHandler();
  }

  // --- Generic command handler factory ---

  private cmdHandler(
    buildCommand: (body: Record<string, unknown>) => BrowserCommand,
  ) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const profile = this.profiles.getOrThrow(param(req, "profileId"));
        const command = buildCommand(req.body as Record<string, unknown>);
        const result = await execBrowserCommand(
          profile.config.endpoint,
          command,
          this.config.agentBrowserBin ? { bin: this.config.agentBrowserBin } : undefined,
        );
        res.json(ok(result));
      } catch (err) {
        next(err);
      }
    };
  }

  // --- Routes ---

  private setupRoutes(): void {
    const r = express.Router();

    // Profile CRUD
    r.post("/profiles", this.createProfile);
    r.get("/profiles", this.listProfiles);
    r.get("/profiles/:id", this.getProfile);
    r.patch("/profiles/:id", this.updateProfile);
    r.delete("/profiles/:id", this.deleteProfile);

    // Generic execute — pass full BrowserCommand as body
    r.post("/profiles/:profileId/execute", this.cmdHandler((body) => body as BrowserCommand));

    // Navigation
    r.post("/profiles/:profileId/open", this.cmdHandler((b) => ({ action: "open", url: b.url as string })));
    r.post("/profiles/:profileId/back", this.cmdHandler(() => ({ action: "back" })));
    r.post("/profiles/:profileId/forward", this.cmdHandler(() => ({ action: "forward" })));
    r.post("/profiles/:profileId/reload", this.cmdHandler(() => ({ action: "reload" })));

    // Observation
    r.post("/profiles/:profileId/snapshot", this.cmdHandler((b) => ({ action: "snapshot", ...b })));
    r.post("/profiles/:profileId/screenshot", this.cmdHandler((b) => ({ action: "screenshot", ...b })));
    r.post("/profiles/:profileId/pdf", this.cmdHandler((b) => ({ action: "pdf", path: b.path as string })));
    r.post("/profiles/:profileId/get", this.cmdHandler((b) => ({
      action: "get", subcommand: b.subcommand as string, ref: b.ref as string | undefined, attr: b.attr as string | undefined,
    })));

    // Interaction
    r.post("/profiles/:profileId/click", this.cmdHandler((b) => ({ action: "click", ref: b.ref as string, newTab: b.newTab as boolean | undefined })));
    r.post("/profiles/:profileId/dblclick", this.cmdHandler((b) => ({ action: "dblclick", ref: b.ref as string })));
    r.post("/profiles/:profileId/fill", this.cmdHandler((b) => ({ action: "fill", ref: b.ref as string, text: b.text as string })));
    r.post("/profiles/:profileId/type", this.cmdHandler((b) => ({ action: "type", ref: b.ref as string, text: b.text as string })));
    r.post("/profiles/:profileId/press", this.cmdHandler((b) => ({ action: "press", key: b.key as string })));
    r.post("/profiles/:profileId/hover", this.cmdHandler((b) => ({ action: "hover", ref: b.ref as string })));
    r.post("/profiles/:profileId/focus", this.cmdHandler((b) => ({ action: "focus", ref: b.ref as string })));
    r.post("/profiles/:profileId/check", this.cmdHandler((b) => ({ action: "check", ref: b.ref as string })));
    r.post("/profiles/:profileId/uncheck", this.cmdHandler((b) => ({ action: "uncheck", ref: b.ref as string })));
    r.post("/profiles/:profileId/select", this.cmdHandler((b) => ({ action: "select", ref: b.ref as string, values: b.values as string[] })));
    r.post("/profiles/:profileId/drag", this.cmdHandler((b) => ({ action: "drag", src: b.src as string, dst: b.dst as string })));
    r.post("/profiles/:profileId/upload", this.cmdHandler((b) => ({ action: "upload", ref: b.ref as string, files: b.files as string[] })));
    r.post("/profiles/:profileId/scroll", this.cmdHandler((b) => ({ action: "scroll", direction: b.direction as "up" | "down" | "left" | "right", pixels: b.pixels as number | undefined })));
    r.post("/profiles/:profileId/scrollintoview", this.cmdHandler((b) => ({ action: "scrollintoview", ref: b.ref as string })));

    // Wait
    r.post("/profiles/:profileId/wait", this.cmdHandler((b) => ({ action: "wait", ...b })));

    // Tabs
    r.post("/profiles/:profileId/tab", this.cmdHandler((b) => ({ action: "tab", ...b } as BrowserCommand)));

    // JavaScript
    r.post("/profiles/:profileId/eval", this.cmdHandler((b) => ({ action: "eval", js: b.js as string })));

    // Cookies & Storage
    r.post("/profiles/:profileId/cookies", this.cmdHandler((b) => ({ action: "cookies", ...b } as BrowserCommand)));
    r.post("/profiles/:profileId/storage", this.cmdHandler((b) => ({ action: "storage", storageType: b.storageType as "local" | "session" })));

    // Health
    r.get("/health", (_req: Request, res: Response) => {
      res.json({ success: true, data: { status: "ok" } });
    });

    this.app.use("/api", r);
  }

  // --- Profile Handlers ---

  private createProfile = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const input = createProfileSchema.parse(req.body);
      const profile = this.profiles.create(input);
      res.status(201).json(ok(profile));
    } catch (err) {
      next(err);
    }
  };

  private listProfiles = (_req: Request, res: Response): void => {
    res.json(ok(this.profiles.list()));
  };

  private getProfile = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const profile = this.profiles.getOrThrow(param(req, "id"));
      res.json(ok(profile));
    } catch (err) {
      next(err);
    }
  };

  private updateProfile = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const input = updateProfileSchema.parse(req.body);
      const profile = this.profiles.update(param(req, "id"), input);
      res.json(ok(profile));
    } catch (err) {
      next(err);
    }
  };

  private deleteProfile = (req: Request, res: Response, next: NextFunction): void => {
    try {
      this.profiles.delete(param(req, "id"));
      res.json(ok({ deleted: true }));
    } catch (err) {
      next(err);
    }
  };

  // --- Error Handler ---

  private setupErrorHandler(): void {
    this.app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof ProfileError) {
        const status = err.code === "NOT_FOUND" ? 404 : 409;
        res.status(status).json(fail(err.message));
        return;
      }

      if (err instanceof ZodError) {
        res.status(400).json(fail(err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")));
        return;
      }

      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(500).json(fail(message));
    });
  }

  // --- Lifecycle ---

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(this.config.port, this.config.host, () => {
        resolve();
      });
    });
  }

  getApp() {
    return this.app;
  }

  getProfileManager() {
    return this.profiles;
  }
}

// --- Response Helpers ---

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function fail(error: string): ApiResponse {
  return { success: false, error };
}
