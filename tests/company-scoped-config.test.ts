import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// COM-108 / COM-118: company-scoped host compatibility.
//
// Paperclip plugin config is stored PER COMPANY. The host hands workers an
// empty bootstrap config and expects `ctx.config.get({ companyId })` for scoped
// values, plus `ctx.secrets.resolve(ref, { companyId, configPath })` for
// per-company secret bindings. Prior to this fix, worker.ts called the
// arg-less forms, so on this host the instance config came back `{}` and setup()
// threw at boot (total Discord outage) while secret resolution failed.
//
// These tests verify:
//   1. getCompanyScopedRuntimeConfig iterates companies, reads company-scoped
//      config, and resolves the bot token with { companyId, configPath }.
//   2. It skips companies without a complete Discord config and returns the
//      first fully-configured one.
//   3. It returns null (clean disable, no throw) when no company is configured.
//   4. setup() boots successfully via the company-scoped path even when the
//      instance-level ctx.config.get() is empty (the outage repro).
// ---------------------------------------------------------------------------

import { getCompanyScopedRuntimeConfig } from "../src/worker.js";

type Company = { id: string };

function buildCtx(opts: {
  companies: Company[];
  configByCompany: Record<string, Record<string, unknown> | undefined>;
  instanceConfig?: Record<string, unknown>;
  resolve?: (ref: string, o?: { companyId?: string; configPath?: string }) => Promise<string>;
}) {
  const resolveSpy = vi.fn(
    opts.resolve ?? (async () => "resolved-token"),
  );
  const configGet = vi.fn(async (params?: { companyId?: string }) => {
    if (params?.companyId) return opts.configByCompany[params.companyId] ?? {};
    return opts.instanceConfig ?? {};
  });

  const ctx = {
    config: { get: configGet },
    secrets: { resolve: resolveSpy },
    companies: { list: vi.fn().mockResolvedValue(opts.companies) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as any;

  return { ctx, resolveSpy, configGet };
}

describe("getCompanyScopedRuntimeConfig (COM-108/COM-118 host compat)", () => {
  it("resolves the bot token with { companyId, configPath }", async () => {
    const { ctx, resolveSpy } = buildCtx({
      companies: [{ id: "company-a" }],
      configByCompany: {
        "company-a": { discordBotTokenRef: "secret-ref-a", defaultChannelId: "ch-a" },
      },
    });

    const result = await getCompanyScopedRuntimeConfig(ctx);

    expect(result).not.toBeNull();
    expect(result!.companyId).toBe("company-a");
    expect(result!.token).toBe("resolved-token");
    expect(resolveSpy).toHaveBeenCalledWith("secret-ref-a", {
      companyId: "company-a",
      configPath: "discordBotTokenRef",
    });
  });

  it("reads config with the company id (not the arg-less instance form)", async () => {
    const { ctx, configGet } = buildCtx({
      companies: [{ id: "company-a" }],
      instanceConfig: {}, // arg-less returns empty — the outage condition
      configByCompany: {
        "company-a": { discordBotTokenRef: "ref", defaultChannelId: "ch" },
      },
    });

    await getCompanyScopedRuntimeConfig(ctx);

    expect(configGet).toHaveBeenCalledWith({ companyId: "company-a" });
  });

  it("skips companies without a complete Discord config and returns the first configured one", async () => {
    const { ctx } = buildCtx({
      companies: [{ id: "empty-co" }, { id: "partial-co" }, { id: "good-co" }],
      configByCompany: {
        "empty-co": {},
        "partial-co": { discordBotTokenRef: "ref" }, // missing defaultChannelId
        "good-co": { discordBotTokenRef: "ref-good", defaultChannelId: "ch-good" },
      },
    });

    const result = await getCompanyScopedRuntimeConfig(ctx);

    expect(result!.companyId).toBe("good-co");
    expect(result!.config.defaultChannelId).toBe("ch-good");
  });

  it("honors preferredCompanyId first", async () => {
    const { ctx } = buildCtx({
      companies: [{ id: "company-a" }, { id: "company-b" }],
      configByCompany: {
        "company-a": { discordBotTokenRef: "ref-a", defaultChannelId: "ch-a" },
        "company-b": { discordBotTokenRef: "ref-b", defaultChannelId: "ch-b" },
      },
    });

    const result = await getCompanyScopedRuntimeConfig(ctx, "company-b");

    expect(result!.companyId).toBe("company-b");
  });

  it("returns null (clean disable, no throw) when no company is configured", async () => {
    const { ctx } = buildCtx({
      companies: [{ id: "empty-co" }],
      configByCompany: { "empty-co": {} },
    });

    await expect(getCompanyScopedRuntimeConfig(ctx)).resolves.toBeNull();
  });

  it("resolves the board API key with its own configPath when present", async () => {
    const { ctx, resolveSpy } = buildCtx({
      companies: [{ id: "company-a" }],
      configByCompany: {
        "company-a": {
          discordBotTokenRef: "bot-ref",
          defaultChannelId: "ch",
          paperclipBoardApiKeyRef: "board-ref",
        },
      },
    });

    const result = await getCompanyScopedRuntimeConfig(ctx);

    expect(result!.paperclipBoardApiKey).toBe("resolved-token");
    expect(resolveSpy).toHaveBeenCalledWith("board-ref", {
      companyId: "company-a",
      configPath: "paperclipBoardApiKeyRef",
    });
  });
});

// ---------------------------------------------------------------------------
// setup() end-to-end: boots via the company-scoped path even when the
// instance-level config is empty. Uses the same definePlugin-capture trick as
// required-config.test.ts.
// ---------------------------------------------------------------------------

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

// eslint-disable-next-line import/first
import "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedSetups.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedSetups[capturedSetups.length - 1];
}

function buildSetupCtx(companyConfig: Record<string, unknown>) {
  const registeredJobs = new Map<string, Function>();
  const ctx = {
    config: {
      get: vi.fn(async (params?: { companyId?: string }) =>
        params?.companyId ? companyConfig : {},
      ),
    },
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
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
    companies: { list: vi.fn().mockResolvedValue([{ id: "company-a" }]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: { list: vi.fn().mockResolvedValue([]) },
    http: { fetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }) },
  } as any;
  return { ctx, registeredJobs };
}

describe("setup() boots via company-scoped config when instance config is empty", () => {
  it("does NOT throw and registers jobs (COM-118 outage repro)", async () => {
    const { ctx, registeredJobs } = buildSetupCtx({
      discordBotTokenRef: "fake-secret-ref",
      defaultChannelId: "ch-1",
      defaultGuildId: "",
      enableIntelligence: false,
      enableEscalations: false,
      enableProactiveSuggestions: false,
      enableCustomCommands: false,
      enableInbound: false,
      digestMode: "off",
    });

    await expect(getSetup()(ctx)).resolves.toBeUndefined();
    expect(registeredJobs.size).toBeGreaterThan(0);
    // Confirms the company-scoped read happened.
    expect(ctx.config.get).toHaveBeenCalledWith({ companyId: "company-a" });
  });
});
