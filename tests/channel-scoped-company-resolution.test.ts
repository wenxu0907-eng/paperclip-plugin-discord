import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  resolveCompanyIdForChannel,
  _resetCompanyIdCache,
} from "../src/company-resolver.js";

/**
 * Regression guard for channel-scoped company resolution (COM-154 follow-up).
 *
 * A single plugin worker serves every company's Discord channels over one
 * gateway connection. Previously the `agent:` / `project:` autocomplete and
 * `/clip assign` resolved the company from a shared instance-scope default
 * (`company_default`, set once via `/clip connect`), so EVERY channel resolved
 * to that one company — e.g. the Executive Assistant channel listing another
 * company's agents, and `/clip assign` targeting the wrong company.
 *
 * The interaction's `channel_id` must instead map back to the company whose
 * Discord config owns that channel.
 */

interface Company {
  id: string;
  defaultChannelId?: string;
  companyChannels?: Record<string, string>;
  channelOverride?: string;
}

function buildCtx(companies: Company[], instanceDefaultCompanyId?: string) {
  return {
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    companies: {
      list: vi.fn(async (_params?: unknown) =>
        companies.map((c) => ({ id: c.id })),
      ),
    },
    config: {
      get: vi.fn(async (params?: { companyId?: string }) => {
        const c = companies.find((x) => x.id === params?.companyId);
        if (!c) return {};
        return {
          defaultChannelId: c.defaultChannelId ?? "",
          companyChannels: c.companyChannels ?? {},
        };
      }),
    },
    state: {
      get: vi.fn(async (params: { scopeKind: string; scopeId?: string; stateKey: string }) => {
        if (params.scopeKind === "instance" && params.stateKey === "company_default") {
          return instanceDefaultCompanyId ? { companyId: instanceDefaultCompanyId } : null;
        }
        if (params.scopeKind === "company" && params.stateKey === "discord-channel") {
          const c = companies.find((x) => x.id === params.scopeId);
          return c?.channelOverride ?? null;
        }
        return null;
      }),
    },
  } as any;
}

const COMPANIES: Company[] = [
  { id: "luchi", defaultChannelId: "1517951847866962121" },
  { id: "exec-assistant", defaultChannelId: "1526110045715300424" },
  { id: "investcom", defaultChannelId: "1526110268080390235" },
];

describe("resolveCompanyIdForChannel", () => {
  beforeEach(() => _resetCompanyIdCache());

  it("resolves the company that owns the channel, not the shared instance default", async () => {
    // instance default points at luchi (the bug's stale `/clip connect` state)
    const ctx = buildCtx(COMPANIES, "luchi");
    // interaction in the Executive Assistant channel must resolve to exec-assistant
    const companyId = await resolveCompanyIdForChannel(ctx, "1526110045715300424");
    expect(companyId).toBe("exec-assistant");
  });

  it("resolves a different channel to its own company", async () => {
    const ctx = buildCtx(COMPANIES, "luchi");
    expect(await resolveCompanyIdForChannel(ctx, "1526110268080390235")).toBe("investcom");
  });

  it("matches a channel from the companyChannels map", async () => {
    const withMap: Company[] = [
      { id: "a", defaultChannelId: "aaa", companyChannels: { a: "extra-a" } },
      { id: "b", defaultChannelId: "bbb" },
    ];
    const ctx = buildCtx(withMap);
    expect(await resolveCompanyIdForChannel(ctx, "extra-a")).toBe("a");
  });

  it("prefers a per-company /clip connect-channel override", async () => {
    const withOverride: Company[] = [
      { id: "a", defaultChannelId: "aaa" },
      { id: "b", defaultChannelId: "bbb", channelOverride: "overridden" },
    ];
    const ctx = buildCtx(withOverride);
    expect(await resolveCompanyIdForChannel(ctx, "overridden")).toBe("b");
  });

  it("falls back to the instance default when the channel is unmapped", async () => {
    const ctx = buildCtx(COMPANIES, "luchi");
    expect(await resolveCompanyIdForChannel(ctx, "9999-unknown")).toBe("luchi");
  });

  it("falls back to the instance default when no channel id is provided", async () => {
    const ctx = buildCtx(COMPANIES, "luchi");
    expect(await resolveCompanyIdForChannel(ctx, undefined)).toBe("luchi");
  });

  it("caches a resolved channel so repeat autocomplete keystrokes don't rescan", async () => {
    const ctx = buildCtx(COMPANIES, "luchi");
    await resolveCompanyIdForChannel(ctx, "1526110045715300424");
    const callsAfterFirst = ctx.companies.list.mock.calls.length;
    await resolveCompanyIdForChannel(ctx, "1526110045715300424");
    expect(ctx.companies.list.mock.calls.length).toBe(callsAfterFirst);
  });
});
