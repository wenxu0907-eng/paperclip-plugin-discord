import { describe, it, expect, vi } from "vitest";

/**
 * Regression guard for the single-company lock (COM-108).
 *
 * A hand-patched build of this plugin once dropped every notification whose
 * `event.companyId` did not match the first company resolved at startup
 * ("Skipping Discord notification for unconfigured company"). Once more than
 * one company had a Discord config, that gate silently swallowed notifications
 * for every company except the locked one.
 *
 * These tests assert the intended multi-company contract:
 *   1. Events for DIFFERENT companies each produce a notification (nothing is
 *      dropped just because a company is not the "first" one).
 *   2. Each company's notification is routed to its own channel via the
 *      `companyChannels` config map.
 *   3. Companies not present in the map fall back to `defaultChannelId`.
 *
 * If anyone reintroduces a single-company gate, test (1) fails immediately.
 */

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

import "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedSetups.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedSetups[capturedSetups.length - 1];
}

function buildPluginContext(configOverrides: Record<string, unknown> = {}) {
  const eventHandlers = new Map<string, Array<(event: any) => Promise<void>>>();
  let discordMessageCount = 0;

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: "fake-secret-ref",
    defaultGuildId: "",
    defaultChannelId: "ch-default",
    approvalsChannelId: "",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: true,
    notifyOnIssueDone: true,
    notifyOnApprovalCreated: false,
    notifyOnAgentError: false,
    enableIntelligence: false,
    intelligenceChannelIds: [],
    backfillDays: 0,
    paperclipBaseUrl: "http://localhost:3100",
    intelligenceRetentionDays: 30,
    escalationChannelId: "",
    enableEscalations: false,
    escalationTimeoutMinutes: 30,
    maxAgentsPerThread: 5,
    enableMediaPipeline: false,
    mediaChannelIds: [],
    enableCustomCommands: false,
    enableProactiveSuggestions: false,
    proactiveScanIntervalMinutes: 15,
    enableCommands: false,
    enableInbound: false,
    topicRouting: false,
    digestMode: "off",
    dailyDigestTime: "09:00",
    bidailySecondTime: "17:00",
    tridailyTimes: "07:00,13:00,19:00",
    ...configOverrides,
  };

  const mockDiscordFetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ id: `msg-${++discordMessageCount}` }),
    text: async () => "",
  }));

  const ctx = {
    config: { get: vi.fn().mockResolvedValue(defaultConfig) },
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      subscribe: vi.fn(),
      emit: vi.fn(),
      on: vi.fn().mockImplementation((name: string, fn: (event: any) => Promise<void>) => {
        const handlers = eventHandlers.get(name) || [];
        handlers.push(fn);
        eventHandlers.set(name, handlers);
        return () => {};
      }),
    },
    // Startup resolves the FIRST company — deliberately company-A, so the test
    // proves company-B (a non-first company) is NOT dropped.
    companies: { list: vi.fn().mockResolvedValue([{ id: "company-A" }]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      listComments: vi.fn().mockResolvedValue([]),
    },
    http: { fetch: mockDiscordFetch },
  } as any;

  return { ctx, eventHandlers, mockDiscordFetch };
}

function makeEvent(companyId: string, eventId: string, payload: Record<string, unknown> = {}): any {
  return {
    eventId,
    eventType: "issue.created",
    occurredAt: new Date().toISOString(),
    companyId,
    entityId: `entity-${eventId}`,
    entityType: "issue",
    payload: { title: "New issue", identifier: "TST-1", ...payload },
  };
}

async function emitEvent(
  eventHandlers: Map<string, Array<(event: any) => Promise<void>>>,
  event: any,
) {
  const handlers = eventHandlers.get("issue.created") || [];
  for (const handler of handlers) {
    await handler(event);
  }
}

function channelPostCalls(mockDiscordFetch: any): string[] {
  return mockDiscordFetch.mock.calls
    .map((call: any[]) => call[0])
    .filter((url: unknown) => typeof url === "string" && (url as string).includes("/channels/"));
}

describe("multi-company notification routing (COM-108 regression guard)", () => {
  it("notifies for a company that is NOT the first-resolved one (no single-company gate)", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      companyChannels: { "company-A": "ch-A", "company-B": "ch-B" },
    });
    await getSetup()(ctx);

    // company-B is a different company than the startup-resolved company-A.
    await emitEvent(eventHandlers, makeEvent("company-B", "evt-b1"));

    const posts = channelPostCalls(mockDiscordFetch);
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain("ch-B");
  });

  it("routes each company's events to its own channel", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      companyChannels: { "company-A": "ch-A", "company-B": "ch-B" },
    });
    await getSetup()(ctx);

    await emitEvent(eventHandlers, makeEvent("company-A", "evt-a1"));
    await emitEvent(eventHandlers, makeEvent("company-B", "evt-b1"));

    const posts = channelPostCalls(mockDiscordFetch);
    expect(posts.length).toBe(2);
    expect(posts.some((u) => u.includes("ch-A"))).toBe(true);
    expect(posts.some((u) => u.includes("ch-B"))).toBe(true);
  });

  it("falls back to defaultChannelId for a company absent from companyChannels", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      companyChannels: { "company-A": "ch-A" },
    });
    await getSetup()(ctx);

    await emitEvent(eventHandlers, makeEvent("company-unmapped", "evt-u1"));

    const posts = channelPostCalls(mockDiscordFetch);
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain("ch-default");
  });

  it("delivers notifications for many companies in the same run", async () => {
    const companyChannels: Record<string, string> = {
      "company-A": "ch-A",
      "company-B": "ch-B",
      "company-C": "ch-C",
      "company-D": "ch-D",
      "company-E": "ch-E",
    };
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({ companyChannels });
    await getSetup()(ctx);

    let i = 0;
    for (const cid of Object.keys(companyChannels)) {
      await emitEvent(eventHandlers, makeEvent(cid, `evt-${i++}`));
    }

    const posts = channelPostCalls(mockDiscordFetch);
    expect(posts.length).toBe(5);
    for (const ch of Object.values(companyChannels)) {
      expect(posts.some((u) => u.includes(ch))).toBe(true);
    }
  });
});
