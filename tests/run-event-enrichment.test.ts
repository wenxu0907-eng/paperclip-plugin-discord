import { describe, it, expect, vi } from "vitest";
import { enrichRunPayload } from "../src/worker.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

// Minimal ctx shaped like the live PluginContext for the fields enrichRunPayload uses.
// Tests only stub agents.list, issues.get, logger.debug, and companies.list.
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
    },
    issues: {
      get: vi.fn().mockResolvedValue(null),
    },
    companies: {
      list: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// Build an agent.run.* event in the shape Paperclip emits today.
// See heartbeat.ts:publishRunLifecyclePluginEvent — entityId is the run id,
// actorId/payload.agentId is the agent id, payload.issueId is optional.
function makeRunEvent(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventType: "agent.run.started",
    eventId: "evt-1",
    companyId: "co-1",
    entityId: "run-uuid",
    entityType: "heartbeat_run",
    actorId: "agent-uuid",
    occurredAt: "2026-05-25T19:00:00Z",
    payload: { runId: "run-uuid", agentId: "agent-uuid", status: "running" },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("enrichRunPayload", () => {
  it("looks up agentName from agents.list when payload.agentName is missing", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockResolvedValue([
          { id: "other-agent", name: "Decoy" },
          { id: "agent-uuid", name: "Scribe" },
        ]),
      },
    });
    const result = await enrichRunPayload(ctx, makeRunEvent());
    expect(result.agentName).toBe("Scribe");
    expect(ctx.agents.list).toHaveBeenCalledWith({ companyId: "co-1" });
  });

  it("preserves an existing payload.agentName and does not call agents.list", async () => {
    const ctx = makeCtx({
      agents: { list: vi.fn().mockResolvedValue([]) },
    });
    const result = await enrichRunPayload(
      ctx,
      makeRunEvent({ payload: { agentId: "agent-uuid", agentName: "Pre-set" } }),
    );
    expect(result.agentName).toBe("Pre-set");
    expect(ctx.agents.list).not.toHaveBeenCalled();
  });

  it("falls back to event.actorId when payload.agentId is absent", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi
          .fn()
          .mockResolvedValue([{ id: "actor-agent", name: "FromActor" }]),
      },
    });
    const result = await enrichRunPayload(
      ctx,
      makeRunEvent({
        actorId: "actor-agent",
        payload: { runId: "run-uuid", status: "running" },
      }),
    );
    expect(result.agentName).toBe("FromActor");
  });

  it("looks up issue identifier and title from issues.get when payload.issueId is present", async () => {
    const ctx = makeCtx({
      issues: {
        get: vi
          .fn()
          .mockResolvedValue({ id: "iss-1", identifier: "TUM-42", title: "Ship Klippy fixes" }),
      },
    });
    const result = await enrichRunPayload(
      ctx,
      makeRunEvent({
        payload: { runId: "run-uuid", agentId: "agent-uuid", issueId: "iss-1" },
      }),
    );
    expect(ctx.issues.get).toHaveBeenCalledWith("iss-1", "co-1");
    expect(result.issueIdentifier).toBe("TUM-42");
    expect(result.issueTitle).toBe("Ship Klippy fixes");
  });

  it("does not call issues.get when payload.issueId is null (no associated issue)", async () => {
    const ctx = makeCtx();
    const result = await enrichRunPayload(
      ctx,
      makeRunEvent({
        payload: { runId: "run-uuid", agentId: "agent-uuid", issueId: null },
      }),
    );
    expect(ctx.issues.get).not.toHaveBeenCalled();
    expect(result.issueIdentifier).toBeUndefined();
    expect(result.issueTitle).toBeUndefined();
  });

  it("returns payload unchanged and skips lookups when companyId is missing", async () => {
    const ctx = makeCtx({
      agents: { list: vi.fn().mockResolvedValue([]) },
      issues: { get: vi.fn().mockResolvedValue(null) },
    });
    const result = await enrichRunPayload(
      ctx,
      makeRunEvent({ companyId: undefined, payload: { agentId: "agent-uuid", issueId: "iss-1" } } as Partial<PluginEvent>),
    );
    expect(ctx.agents.list).not.toHaveBeenCalled();
    expect(ctx.issues.get).not.toHaveBeenCalled();
    expect(result.agentName).toBeUndefined();
    expect(result.issueIdentifier).toBeUndefined();
  });

  it("swallows lookup errors and returns the unenriched payload (notifications must not be blocked)", async () => {
    const ctx = makeCtx({
      agents: {
        list: vi.fn().mockRejectedValue(new Error("agent list exploded")),
      },
    });
    const result = await enrichRunPayload(ctx, makeRunEvent());
    expect(ctx.logger.debug).toHaveBeenCalled();
    expect(result.runId).toBe("run-uuid"); // original payload preserved
    expect(result.agentName).toBeUndefined();
  });
});
