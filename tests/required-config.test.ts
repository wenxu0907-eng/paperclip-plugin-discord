import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Issue #53: setup() used to "warn and return" when required config was
// missing, silently disabling the plugin (and falling through to an empty
// defaultChannelId). It was changed to throw so a misconfiguration failed
// fast and visibly.
//
// COM-430 revised that: a throw inside setup() fails worker `initialize`, which
// marks the WHOLE plugin `error` and stops it from activating at all — and the
// thrown message replaces the health diagnostic the board needs to fix the
// config. Missing config now disables the runtime loudly instead: setup()
// resolves, an error is logged naming the missing field, no jobs are
// registered, and onHealth() reports `degraded`.
//
// These tests pin that contract, including the "loudly" half — a silent
// warn-and-return is still a regression.
// ---------------------------------------------------------------------------

// Capture the plugin definition from definePlugin by mocking the SDK.
// vi.hoisted ensures the variable exists before the mock factory runs.
const { capturedDefs } = vi.hoisted(() => {
  const capturedDefs: Array<any> = [];
  return { capturedDefs };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    capturedDefs.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

// Now import the worker — the mock intercepts definePlugin.
// This must be a static import so vitest hoists the mock before it.
import "../src/worker.js";

function getDefinition(): any {
  if (capturedDefs.length === 0) {
    throw new Error("definePlugin was not captured — the SDK mock may not be active");
  }
  return capturedDefs[capturedDefs.length - 1];
}

function getSetup(): (ctx: any) => Promise<void> {
  return getDefinition().setup;
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

/** Collect every string argument the logger saw, across all levels. */
function loggedText(ctx: any): string {
  return [ctx.logger.error, ctx.logger.warn, ctx.logger.info]
    .flatMap((fn: any) => fn.mock.calls)
    .map((call: unknown[]) => JSON.stringify(call))
    .join("\n");
}

describe("setup() required-config validation (issue #53, revised by COM-430)", () => {
  it("disables the runtime instead of throwing when discordBotTokenRef is missing", async () => {
    const { ctx, registeredJobs } = buildPluginContext(
      validConfig({ discordBotTokenRef: undefined }),
    );
    await expect(getSetup()(ctx)).resolves.toBeUndefined();
    expect(loggedText(ctx)).toMatch(/discordBotTokenRef/);
    expect(registeredJobs.size).toBe(0);
  });

  it("disables the runtime when discordBotTokenRef is empty/whitespace", async () => {
    const { ctx, registeredJobs } = buildPluginContext(validConfig({ discordBotTokenRef: "   " }));
    await expect(getSetup()(ctx)).resolves.toBeUndefined();
    expect(loggedText(ctx)).toMatch(/discordBotTokenRef/);
    expect(registeredJobs.size).toBe(0);
  });

  it("disables the runtime when defaultChannelId is missing", async () => {
    const { ctx, registeredJobs } = buildPluginContext(validConfig({ defaultChannelId: undefined }));
    await expect(getSetup()(ctx)).resolves.toBeUndefined();
    expect(loggedText(ctx)).toMatch(/defaultChannelId/);
    expect(registeredJobs.size).toBe(0);
  });

  it("disables the runtime when defaultChannelId is empty/whitespace", async () => {
    const { ctx, registeredJobs } = buildPluginContext(validConfig({ defaultChannelId: "  " }));
    await expect(getSetup()(ctx)).resolves.toBeUndefined();
    expect(loggedText(ctx)).toMatch(/defaultChannelId/);
    expect(registeredJobs.size).toBe(0);
  });

  it("scopes the diagnostic to the plugin", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: "" }));
    await getSetup()(ctx);
    expect(loggedText(ctx)).toMatch(/paperclip-plugin-discord/);
  });

  it("reports degraded health so the board can see why Discord is off", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: "" }));
    await getSetup()(ctx);
    const health = await getDefinition().onHealth();
    expect(health.status).toBe("degraded");
    expect(String(health.message)).toMatch(/discordBotTokenRef/);
  });

  it("does NOT fail silently — the missing field is logged at error level", async () => {
    const { ctx } = buildPluginContext(validConfig({ discordBotTokenRef: "" }));
    await getSetup()(ctx);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("succeeds when both required fields are present", async () => {
    const { ctx, registeredJobs } = buildPluginContext(validConfig());
    await expect(getSetup()(ctx)).resolves.toBeUndefined();
    // Sanity: setup ran far enough to register jobs.
    expect(registeredJobs.size).toBeGreaterThan(0);
  });
});
