import type { CreateProfileInput, Profile, UpdateProfileInput } from "./types.ts";

/**
 * In-memory profile store. Each profile holds a CDP config
 * used to connect agent-browser to a remote Chrome instance.
 */
export class ProfileManager {
  private readonly profiles = new Map<string, Profile>();

  create(input: CreateProfileInput): Profile {
    if (this.profiles.has(input.id)) {
      throw new ProfileError(`Profile "${input.id}" already exists`, "CONFLICT");
    }

    const now = new Date().toISOString();
    const profile: Profile = {
      id: input.id,
      type: input.type,
      config: { ...input.config },
      createdAt: now,
      updatedAt: now,
    };

    this.profiles.set(input.id, profile);
    return profile;
  }

  get(id: string): Profile | undefined {
    return this.profiles.get(id);
  }

  getOrThrow(id: string): Profile {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new ProfileError(`Profile "${id}" not found`, "NOT_FOUND");
    }
    return profile;
  }

  list(): readonly Profile[] {
    return [...this.profiles.values()];
  }

  update(id: string, input: UpdateProfileInput): Profile {
    const existing = this.getOrThrow(id);

    const updated: Profile = {
      ...existing,
      config: { ...existing.config, ...input.config },
      updatedAt: new Date().toISOString(),
    };

    this.profiles.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    if (!this.profiles.has(id)) {
      throw new ProfileError(`Profile "${id}" not found`, "NOT_FOUND");
    }
    return this.profiles.delete(id);
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }
}

export type ProfileErrorCode = "NOT_FOUND" | "CONFLICT";

export class ProfileError extends Error {
  constructor(
    message: string,
    public readonly code: ProfileErrorCode,
  ) {
    super(message);
    this.name = "ProfileError";
  }
}
