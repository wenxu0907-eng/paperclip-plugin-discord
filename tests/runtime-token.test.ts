import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  SECRET_RESOLUTION_DISABLED_MESSAGE,
  SECRET_RESOLUTION_ISSUE_URL,
  resolveStartupDiscordBotToken,
  type DiscordRuntimeHealth,
} from "../src/runtime-token.js";

function makeContext(resolve: () => Promise<string>): PluginContext {
  return {
    secrets: { resolve },
    logger: {
      error: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe("resolveStartupDiscordBotToken", () => {
  it("returns the resolved bot token and marks health ok", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const ctx = makeContext(async () => "bot-token");

    const token = await resolveStartupDiscordBotToken(ctx, "secret-ref", (next) => health.push(next));

    expect(token).toBe("bot-token");
    expect(health).toEqual([{ status: "ok" }]);
  });

  it("degrades health and does not throw when Paperclip secret resolution fails", async () => {
    const health: DiscordRuntimeHealth[] = [];
    const ctx = makeContext(async () => {
      throw new Error(SECRET_RESOLUTION_DISABLED_MESSAGE);
    });

    const token = await resolveStartupDiscordBotToken(ctx, "secret-ref", (next) => health.push(next));

    expect(token).toBeUndefined();
    expect(health).toEqual([{
      status: "degraded",
      message: SECRET_RESOLUTION_DISABLED_MESSAGE,
      details: {
        issue: "paperclip-plugin-secret-resolution-disabled",
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    }]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Discord plugin cannot resolve bot token secret; runtime features are disabled",
      {
        error: `Error: ${SECRET_RESOLUTION_DISABLED_MESSAGE}`,
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    );
  });
});
