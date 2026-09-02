import { describe, it, expect, vi } from "vitest";

/**
 * Regression guard for the cross-tenant notification leak (COM-435).
 *
 * The board unchecked "Notify on issue created" for Luchi Studio and still got
 * an issue-created message in Luchi's Discord channel. Cause: every `notifyOn*`
 * toggle was evaluated ONCE at startup against the bootstrap config — the first
 * company that happened to have a complete Discord config. Other companies with
 * the toggle ON kept the handler registered, and `notify()` then routed each
 * event to the *event's* company channel via `companyChannels`, so a company
 * that opted out still received the message in its own channel.
 *
 * The contract asserted here:
 *   1. A company with the toggle OFF gets NOTHING, even when another company
 *      has it ON (the leak).
 *   2. A company with the toggle ON still gets its notification (the fix must
 *      not over-correct into dropping everything).
 *   3. Registration happens when ANY company enables the event — gating
 *      registration on one company's config makes the toggle un-flippable
 *      without a worker restart.
 *   4. The per-company toggle is re-read at delivery time, so flipping it in
 *      the UI takes effect without restarting the worker.
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

const BASE_CONFIG: Record<string, unknown> = {
  discordBotTokenRef: "fake-secret-ref",
  defaultGuildId: "",
  defaultChannelId: "ch-default",
  approvalsChannelId: "",
  errorsChannelId: "",
  bdPipelineChannelId: "",
  notifyOnIssueCreated: false,
  notifyOnIssueInReview: false,
  notifyOnIssueDone: false,
  notifyOnIssueBlocked: false,
  notifyOnBoardInputRequested: false,
  notifyOnApprovalCreated: false,
  notifyOnAgentError: false,
  notifyOnRunStarted: false,
  notifyOnRunFinished: false,
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
};

/**
 * @param perCompany company id -> config overrides merged over BASE_CONFIG.
 *   `ctx.config.get(companyId)` answers from this map, exactly like the host's
 *   company-scoped plugin config.
 */
function buildPluginContext(perCompany: Record<string, Record<string, unknown>>) {
  const eventHandlers = new Map<string, Array<(event: any) => Promise<void>>>();
  let discordMessageCount = 0;

  const companyIds = Object.keys(perCompany);
  const configFor = (companyId?: string): Record<string, unknown> => {
    const overrides = companyId ? perCompany[companyId] : undefined;
    if (!overrides) return {};
    const channels: Record<string, string> = {};
    for (const id of companyIds) channels[id] = `ch-${id}`;
    return { ...BASE_CONFIG, companyChannels: channels, ...overrides };
  };

  const mockDiscordFetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    json: async () => ({ id: `msg-${++discordMessageCount}` }),
    text: async () => "",
  }));

  const configGet = vi.fn().mockImplementation(async (companyId?: string) => configFor(companyId));

  const ctx = {
    config: { get: configGet },
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
    companies: { list: vi.fn().mockResolvedValue(companyIds.map((id) => ({ id }))) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      listComments: vi.fn().mockResolvedValue([]),
    },
    http: { fetch: mockDiscordFetch },
  } as any;

  return { ctx, eventHandlers, mockDiscordFetch, configGet, perCompany };
}

function makeEvent(eventType: string, companyId: string, eventId: string, payload: Record<string, unknown> = {}) {
  return {
    eventId,
    eventType,
    occurredAt: "2026-09-01T00:00:00Z",
    companyId,
    entityId: `entity-${eventId}`,
    entityType: "issue",
    payload: { title: "New issue", identifier: "TST-1", ...payload },
  };
}

async function emit(
  eventHandlers: Map<string, Array<(event: any) => Promise<void>>>,
  eventType: string,
  event: any,
) {
  for (const handler of eventHandlers.get(eventType) || []) {
    await handler(event);
  }
}

function channelPosts(mockDiscordFetch: any): string[] {
  return mockDiscordFetch.mock.calls
    .map((call: any[]) => call[0])
    .filter((url: unknown) => typeof url === "string" && (url as string).includes("/channels/"));
}

describe("per-company notification toggles (COM-435)", () => {
  it("does NOT post issue.created for a company that unchecked it, while another company has it on", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      "company-on": { notifyOnIssueCreated: true },
      "company-off": { notifyOnIssueCreated: false },
    });
    await getSetup()(ctx);

    await emit(eventHandlers, "issue.created", makeEvent("issue.created", "company-off", "evt-off"));

    expect(channelPosts(mockDiscordFetch)).toEqual([]);
  });

  it("still posts issue.created for the company that has it on", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      "company-on": { notifyOnIssueCreated: true },
      "company-off": { notifyOnIssueCreated: false },
    });
    await getSetup()(ctx);

    await emit(eventHandlers, "issue.created", makeEvent("issue.created", "company-on", "evt-on"));

    const posts = channelPosts(mockDiscordFetch);
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain("ch-company-on");
  });

  it("registers issue.created when ANY company enables it, even if the bootstrap company does not", async () => {
    // company-off sorts first, so it is the bootstrap company whose config used
    // to decide registration for everyone.
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      "company-off": { notifyOnIssueCreated: false },
      "company-on": { notifyOnIssueCreated: true },
    });
    await getSetup()(ctx);

    expect(eventHandlers.has("issue.created")).toBe(true);

    await emit(eventHandlers, "issue.created", makeEvent("issue.created", "company-on", "evt-on"));
    expect(channelPosts(mockDiscordFetch).length).toBe(1);
  });

  it("does not register issue.created when NO company enables it", async () => {
    const { ctx, eventHandlers } = buildPluginContext({
      "company-off": { notifyOnIssueCreated: false },
      "company-off-2": { notifyOnIssueCreated: false },
    });
    await getSetup()(ctx);

    expect(eventHandlers.has("issue.created")).toBe(false);
  });

  it("gates issue.updated status branches per company", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      "company-on": { notifyOnIssueDone: true, notifyOnIssueBlocked: true },
      "company-off": { notifyOnIssueDone: false, notifyOnIssueBlocked: false },
    });
    await getSetup()(ctx);

    await emit(
      eventHandlers,
      "issue.updated",
      makeEvent("issue.updated", "company-off", "evt-done-off", { status: "done" }),
    );
    await emit(
      eventHandlers,
      "issue.updated",
      makeEvent("issue.updated", "company-off", "evt-blocked-off", { status: "blocked" }),
    );
    expect(channelPosts(mockDiscordFetch)).toEqual([]);

    await emit(
      eventHandlers,
      "issue.updated",
      makeEvent("issue.updated", "company-on", "evt-done-on", { status: "done" }),
    );
    const posts = channelPosts(mockDiscordFetch);
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain("ch-company-on");
  });

  it("gates agent run notifications per company", async () => {
    const { ctx, eventHandlers, mockDiscordFetch } = buildPluginContext({
      "company-on": { notifyOnRunFinished: true },
      "company-off": { notifyOnRunFinished: false },
    });
    await getSetup()(ctx);

    await emit(
      eventHandlers,
      "agent.run.finished",
      makeEvent("agent.run.finished", "company-off", "evt-run-off"),
    );
    expect(channelPosts(mockDiscordFetch)).toEqual([]);

    await emit(
      eventHandlers,
      "agent.run.finished",
      makeEvent("agent.run.finished", "company-on", "evt-run-on"),
    );
    expect(channelPosts(mockDiscordFetch).length).toBe(1);
  });

  it("picks up a toggle flipped after startup once the config cache expires", async () => {
    vi.useFakeTimers();
    try {
      const built = buildPluginContext({
        "company-on": { notifyOnIssueCreated: true },
        "company-flip": { notifyOnIssueCreated: false },
      });
      await getSetup()(built.ctx);

      await emit(
        built.eventHandlers,
        "issue.created",
        makeEvent("issue.created", "company-flip", "evt-1"),
      );
      expect(channelPosts(built.mockDiscordFetch)).toEqual([]);

      // Board checks the box in the UI.
      built.perCompany["company-flip"].notifyOnIssueCreated = true;
      vi.advanceTimersByTime(60_000);

      await emit(
        built.eventHandlers,
        "issue.created",
        makeEvent("issue.created", "company-flip", "evt-2"),
      );
      const posts = channelPosts(built.mockDiscordFetch);
      expect(posts.length).toBe(1);
      expect(posts[0]).toContain("ch-company-flip");
    } finally {
      vi.useRealTimers();
    }
  });
});
