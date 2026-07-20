import { describe, it, expect, vi } from "vitest";
import { formatIssueInReview } from "../src/formatters.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

// ---------------------------------------------------------------------------
// COM-109: the board wants to filter which Discord notifications it receives.
// Two capabilities are exercised here:
//   1. Per-event toggles gate ctx.events.on(...) registration, so run
//      lifecycle noise can be turned OFF and issue "in review" turned ON.
//   2. formatIssueInReview renders a distinct "ready for review" embed.
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

import "../src/worker.js";

function getSetup(): (ctx: any) => Promise<void> {
  if (capturedSetups.length === 0) {
    throw new Error("setup() was not captured — definePlugin mock may not be active");
  }
  return capturedSetups[capturedSetups.length - 1];
}

function buildPluginContext(configOverrides: Record<string, unknown> = {}) {
  // eventName -> list of handlers registered for it
  const eventHandlers = new Map<string, Function[]>();

  const defaultConfig: Record<string, unknown> = {
    discordBotTokenRef: "fake-secret-ref",
    defaultGuildId: "",
    defaultChannelId: "ch-1",
    approvalsChannelId: "",
    errorsChannelId: "",
    bdPipelineChannelId: "",
    notifyOnIssueCreated: false,
    notifyOnIssueInReview: false,
    notifyOnIssueDone: false,
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
    ...configOverrides,
  };

  const ctx = {
    config: { get: vi.fn().mockResolvedValue(defaultConfig) },
    secrets: { resolve: vi.fn().mockResolvedValue("fake-bot-token") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      subscribe: vi.fn(),
      emit: vi.fn(),
      on: vi.fn().mockImplementation((name: string, handler: Function) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      }),
    },
    companies: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]), invoke: vi.fn() },
    issues: { list: vi.fn().mockResolvedValue([]) },
    http: {
      fetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    },
  } as any;

  return { ctx, eventHandlers };
}

async function runSetup(configOverrides: Record<string, unknown> = {}) {
  const { ctx, eventHandlers } = buildPluginContext(configOverrides);
  await getSetup()(ctx);
  return { ctx, eventHandlers };
}

describe("notification toggles gate event registration", () => {
  it("does NOT register run lifecycle handlers when run toggles are off", async () => {
    const { eventHandlers } = await runSetup({
      notifyOnRunStarted: false,
      notifyOnRunFinished: false,
    });
    expect(eventHandlers.has("agent.run.started")).toBe(false);
    expect(eventHandlers.has("agent.run.finished")).toBe(false);
  });

  it("registers run lifecycle handlers when run toggles are on", async () => {
    const { eventHandlers } = await runSetup({
      notifyOnRunStarted: true,
      notifyOnRunFinished: true,
    });
    expect(eventHandlers.has("agent.run.started")).toBe(true);
    expect(eventHandlers.has("agent.run.finished")).toBe(true);
  });

  it("registers issue.updated when only the in-review toggle is on", async () => {
    const { eventHandlers } = await runSetup({
      notifyOnIssueInReview: true,
      notifyOnIssueDone: false,
    });
    expect(eventHandlers.has("issue.updated")).toBe(true);
  });

  it("registers issue.updated when only the blocked toggle is on", async () => {
    const { eventHandlers } = await runSetup({
      notifyOnIssueInReview: false,
      notifyOnIssueDone: false,
      notifyOnIssueBlocked: true,
    });
    expect(eventHandlers.has("issue.updated")).toBe(true);
  });

  it("does NOT register issue.updated when all issue-status toggles are off", async () => {
    const { eventHandlers } = await runSetup({
      notifyOnIssueInReview: false,
      notifyOnIssueDone: false,
      notifyOnIssueBlocked: false,
    });
    expect(eventHandlers.has("issue.updated")).toBe(false);
  });

  it("registers issue.interaction.created when the board-input toggle is on", async () => {
    const { eventHandlers } = await runSetup({
      notifyOnBoardInputRequested: true,
    });
    expect(eventHandlers.has("issue.interaction.created")).toBe(true);
  });

  it("does NOT register issue.interaction.created when the board-input toggle is off", async () => {
    const { eventHandlers } = await runSetup({
      notifyOnBoardInputRequested: false,
    });
    expect(eventHandlers.has("issue.interaction.created")).toBe(false);
  });

  it("defaults keep run lifecycle noise off but in-review + done on", () => {
    expect(DEFAULT_CONFIG.notifyOnRunStarted).toBe(false);
    expect(DEFAULT_CONFIG.notifyOnRunFinished).toBe(false);
    expect(DEFAULT_CONFIG.notifyOnIssueInReview).toBe(true);
    expect(DEFAULT_CONFIG.notifyOnIssueDone).toBe(true);
    expect(DEFAULT_CONFIG.notifyOnIssueBlocked).toBe(true);
    expect(DEFAULT_CONFIG.notifyOnBoardInputRequested).toBe(true);
  });
});

describe("formatIssueInReview", () => {
  it("renders a distinct 'ready for review' embed", () => {
    const msg = formatIssueInReview({
      entityId: "issue-123",
      occurredAt: "2026-07-13T00:00:00Z",
      payload: {
        identifier: "COM-42",
        title: "Ship the thing",
        status: "in_review",
        priority: "high",
        assigneeName: "Wen's Executive Assistant",
      },
    } as any);

    expect(msg.embeds[0].title).toContain("COM-42");
    expect(msg.embeds[0].title).toMatch(/review/i);
    expect(JSON.stringify(msg.embeds[0].fields)).toContain("In Review");
  });
});
