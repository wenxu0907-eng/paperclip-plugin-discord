import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Issue #53: setup() used to "warn and return" when required config was
// missing, silently disabling the plugin (and falling through to an empty
// defaultChannelId). It now throws a clear, plugin-scoped error so a
// misconfiguration fails fast and visibly.
//
// These tests verify setup() throws when discordBotTokenRef or defaultChannelId
// are missing, and succeeds when both are present.
// ---------------------------------------------------------------------------

// Capture the setup function from definePlugin by mocking the SDK.
// vi.hoisted ensures the variable exists before the mock factory runs.
const { capturedSetups } = vi.hoisted(() => {
  const capturedSetups: Array<(ctx: any) => Promise<void>> = [];
  return { capturedSetups };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedSetups.push(def.setup);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

// Now import the worker — the mock intercepts definePlugin.
// This must be a static import so vitest hoists the mock before it.
import "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedSetups.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedSetups[capturedSetups.length - 1];
}

/**
 * Build a minimal PluginContext stub. The config passed to ctx.config.get()
 * is whatever `config` is provided — deliberately NOT merged with sane
 * defaults so a missing required field actually reaches setup() as missing.
 */
function buildPluginContext(config: Record<string, unknown>) {
  const registeredJobs = new Map<string, Function>();

  const ctx = {
    config: { get: vi.fn().mockResolvedValue(config) },
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    jobs: {
      register: vi.fn().mockImplementation((key: string, handler: Function) => {
        registeredJobs.set(key, handler);
      }),
    },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: { subscribe: vi.fn(), emit: vi.fn(), on: vi.fn() },
    companies: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: { list: vi.fn().mockResolvedValue([]) },
    http: {
      fetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    },
  } as any;

  return { ctx, registeredJobs };
}

/** A config with all required fields present and features off. */
function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    discordBotTokenRef: "fake-secret-ref",
    defaultChannelId: "ch-1",
    defaultGuildId: "",
    enableIntelligence: false,
    intelligenceChannelIds: [],
    enableEscalations: false,
    enableProactiveSuggestions: false,
    enableCustomCommands: false,
    enableInbound: false,
    digestMode: "off",
    ...overrides,
  };
}

describe("setup() required-config validation (issue #53)", () => {
  it("throws when discordBotTokenRef is missing", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: undefined }));
    await expect(getSetup()(ctx)).rejects.toThrow(/discordBotTokenRef is required/);
  });

  it("throws when discordBotTokenRef is empty/whitespace", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: "   " }));
    await expect(getSetup()(ctx)).rejects.toThrow(/discordBotTokenRef is required/);
  });

  it("throws when defaultChannelId is missing", async () => {
    const { ctx } = buildPluginContext(validConfig({ defaultChannelId: undefined }));
    await expect(getSetup()(ctx)).rejects.toThrow(/defaultChannelId is required/);
  });

  it("throws when defaultChannelId is empty/whitespace", async () => {
    const { ctx } = buildPluginContext(validConfig({ defaultChannelId: "  " }));
    await expect(getSetup()(ctx)).rejects.toThrow(/defaultChannelId is required/);
  });

  it("scopes the error message to the plugin", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: "" }));
    await expect(getSetup()(ctx)).rejects.toThrow(/paperclip-plugin-discord/);
  });

  it("does NOT warn-and-return — the old soft path is gone", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: "" }));
    await expect(getSetup()(ctx)).rejects.toThrow();
    // The removed code logged a warning instead of throwing; ensure that path
    // is not what handled the missing token.
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("plugin disabled"),
    );
  });

  it("succeeds when both required fields are present", async () => {
    const { ctx, registeredJobs } = buildPluginContext(validConfig());
    await expect(getSetup()(ctx)).resolves.toBeUndefined();
    // Sanity: setup ran far enough to register jobs.
    expect(registeredJobs.size).toBeGreaterThan(0);
  });
});
