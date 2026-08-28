import { describe, it, expect, vi } from "vitest";
import {
  describeSecretRef,
  hasSecretRef,
  isSecretRefBinding,
  normalizeSecretRef,
} from "../src/secret-ref.js";
import { getCompanyScopedRuntimeConfig } from "../src/worker.js";

// ---------------------------------------------------------------------------
// COM-430: the host tightened `ctx.secrets.resolve()` to accept ONLY
// `{ type: "secret_ref", secretId, version? }`. Stored company config still
// holds a legacy bare secret UUID, so every company's config failed to load,
// setup() fell through to the instance-level `ctx.config.get()` (rejected with
// "company context is required"), and the plugin failed activation entirely.
// ---------------------------------------------------------------------------

const UUID = "4115ff5c-3c01-4bcb-81da-d486b7f4f109";

describe("normalizeSecretRef", () => {
  it("upgrades a legacy bare UUID to the object form the host requires", () => {
    expect(normalizeSecretRef(UUID)).toEqual({ type: "secret_ref", secretId: UUID });
  });

  it("trims surrounding whitespace on a legacy UUID", () => {
    expect(normalizeSecretRef(`  ${UUID}  `)).toEqual({ type: "secret_ref", secretId: UUID });
  });

  it("passes an already-canonical binding through, preserving version", () => {
    expect(normalizeSecretRef({ type: "secret_ref", secretId: UUID, version: "3" })).toEqual({
      type: "secret_ref",
      secretId: UUID,
      version: "3",
    });
  });

  it("passes an opaque non-UUID reference string through unchanged", () => {
    // Older hosts and test doubles accept opaque reference strings; converting
    // these would break them.
    expect(normalizeSecretRef("fake-secret-ref")).toBe("fake-secret-ref");
  });

  it("returns null for empty, whitespace, and absent values", () => {
    expect(normalizeSecretRef("")).toBeNull();
    expect(normalizeSecretRef("   ")).toBeNull();
    expect(normalizeSecretRef(undefined)).toBeNull();
    expect(normalizeSecretRef(null)).toBeNull();
  });
});

describe("isSecretRefBinding / hasSecretRef", () => {
  it("accepts a well-formed binding and rejects malformed ones", () => {
    expect(isSecretRefBinding({ type: "secret_ref", secretId: UUID })).toBe(true);
    expect(isSecretRefBinding({ type: "secret_ref", secretId: "not-a-uuid" })).toBe(false);
    expect(isSecretRefBinding({ type: "plain", value: "x" })).toBe(false);
    expect(isSecretRefBinding(UUID)).toBe(false);
    expect(isSecretRefBinding(null)).toBe(false);
  });

  it("treats both stored shapes as configured", () => {
    expect(hasSecretRef(UUID)).toBe(true);
    expect(hasSecretRef({ type: "secret_ref", secretId: UUID })).toBe(true);
    expect(hasSecretRef("")).toBe(false);
    expect(hasSecretRef(undefined)).toBe(false);
  });

  it("never renders a resolved value in log output", () => {
    expect(describeSecretRef(UUID)).toBe(`legacy:${UUID}`);
    expect(describeSecretRef({ type: "secret_ref", secretId: UUID })).toBe(`secret_ref:${UUID}`);
    expect(describeSecretRef("")).toBe("<empty>");
  });
});

function buildCtx(config: Record<string, unknown>, resolve: any) {
  return {
    config: { get: vi.fn(async (companyId?: string) => (companyId ? config : {})) },
    secrets: { resolve },
    companies: { list: vi.fn().mockResolvedValue([{ id: "company-1" }]) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;
}

describe("getCompanyScopedRuntimeConfig (COM-430 regression)", () => {
  it("resolves a legacy bare-UUID token ref against a host that requires the object form", async () => {
    // Mirrors the hardened host: a bare string is rejected outright.
    const resolve = vi.fn(async (ref: unknown) => {
      if (typeof ref === "string") {
        throw new Error(
          `Invalid secret reference for plugin: ${ref}. Use { type: "secret_ref", secretId, version? }`,
        );
      }
      return "bot-token";
    });
    const ctx = buildCtx({ discordBotTokenRef: UUID, defaultChannelId: "ch-1" }, resolve);

    const scoped = await getCompanyScopedRuntimeConfig(ctx);

    expect(scoped).not.toBeNull();
    expect(scoped!.companyId).toBe("company-1");
    expect(scoped!.token).toBe("bot-token");
    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: UUID },
      { companyId: "company-1", configPath: "discordBotTokenRef" },
    );
  });

  it("resolves a config already stored in the object form the board UI writes", async () => {
    const resolve = vi.fn().mockResolvedValue("bot-token");
    const ctx = buildCtx(
      {
        discordBotTokenRef: { type: "secret_ref", secretId: UUID, version: "latest" },
        defaultChannelId: "ch-1",
      },
      resolve,
    );

    const scoped = await getCompanyScopedRuntimeConfig(ctx);

    expect(scoped!.token).toBe("bot-token");
    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: UUID, version: "latest" },
      { companyId: "company-1", configPath: "discordBotTokenRef" },
    );
  });

  it("skips a company whose token ref is absent rather than resolving an empty ref", async () => {
    const resolve = vi.fn().mockResolvedValue("bot-token");
    const ctx = buildCtx({ discordBotTokenRef: "", defaultChannelId: "ch-1" }, resolve);

    expect(await getCompanyScopedRuntimeConfig(ctx)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
