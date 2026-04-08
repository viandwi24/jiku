import { describe, test, expect } from "bun:test";
import { ProfileManager, ProfileError } from "../profile-manager.ts";

describe("ProfileManager", () => {
  test("create a CDP profile", () => {
    const pm = new ProfileManager();
    const profile = pm.create({
      id: "test-1",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    expect(profile.id).toBe("test-1");
    expect(profile.type).toBe("cdp");
    expect(profile.config.endpoint).toBe("ws://localhost:9222");
    expect(profile.createdAt).toBeTruthy();
    expect(profile.updatedAt).toBeTruthy();
  });

  test("reject duplicate profile id", () => {
    const pm = new ProfileManager();
    pm.create({ id: "dup", type: "cdp", config: { endpoint: "ws://localhost:9222" } });

    expect(() =>
      pm.create({ id: "dup", type: "cdp", config: { endpoint: "ws://localhost:9222" } }),
    ).toThrow(ProfileError);
  });

  test("get existing profile", () => {
    const pm = new ProfileManager();
    pm.create({ id: "abc", type: "cdp", config: { endpoint: "ws://localhost:9222" } });

    const profile = pm.get("abc");
    expect(profile).toBeDefined();
    expect(profile!.id).toBe("abc");
  });

  test("get returns undefined for missing profile", () => {
    const pm = new ProfileManager();
    expect(pm.get("missing")).toBeUndefined();
  });

  test("getOrThrow throws for missing profile", () => {
    const pm = new ProfileManager();
    expect(() => pm.getOrThrow("missing")).toThrow(ProfileError);
  });

  test("list returns all profiles", () => {
    const pm = new ProfileManager();
    pm.create({ id: "a", type: "cdp", config: { endpoint: "ws://a:9222" } });
    pm.create({ id: "b", type: "cdp", config: { endpoint: "ws://b:9222" } });

    const list = pm.list();
    expect(list).toHaveLength(2);
  });

  test("update profile config", () => {
    const pm = new ProfileManager();
    pm.create({ id: "upd", type: "cdp", config: { endpoint: "ws://old:9222" } });

    const updated = pm.update("upd", { config: { endpoint: "ws://new:9222" } });
    expect(updated.config.endpoint).toBe("ws://new:9222");
    expect(updated.id).toBe("upd");
  });

  test("delete profile", () => {
    const pm = new ProfileManager();
    pm.create({ id: "del", type: "cdp", config: { endpoint: "ws://localhost:9222" } });

    expect(pm.delete("del")).toBe(true);
    expect(pm.has("del")).toBe(false);
  });

  test("delete missing profile throws", () => {
    const pm = new ProfileManager();
    expect(() => pm.delete("nope")).toThrow(ProfileError);
  });
});
