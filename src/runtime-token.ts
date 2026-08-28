import type { PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";
import { describeSecretRef, normalizeSecretRef, type SecretRefBinding, type SecretRefValue } from "./secret-ref.js";

export type DiscordRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

export const SECRET_RESOLUTION_DISABLED_MESSAGE = "Plugin secret references are disabled until company-scoped plugin config lands";
export const SECRET_RESOLUTION_ISSUE_URL = "https://github.com/mvanhorn/paperclip-plugin-discord/issues/61";

export async function resolveStartupDiscordBotToken(
  ctx: PluginContext,
  tokenRef: SecretRefValue,
  setHealth: (health: DiscordRuntimeHealth) => void,
): Promise<string | undefined> {
  // The host accepts only the object form; normalize legacy bare UUIDs (COM-430).
  const normalized = normalizeSecretRef(tokenRef);
  if (!normalized) {
    setHealth({
      status: "degraded",
      message: "Discord bot token reference is not a usable secret reference.",
      details: { tokenRef: describeSecretRef(tokenRef) },
    });
    ctx.logger.error("Discord plugin bot token ref is not a usable secret reference", {
      tokenRef: describeSecretRef(tokenRef),
    });
    return undefined;
  }
  try {
    const resolve = ctx.secrets.resolve as unknown as (
      ref: SecretRefBinding | string,
    ) => Promise<string>;
    const token = await resolve(normalized);
    setHealth({ status: "ok" });
    return token;
  } catch (err) {
    const error = String(err);
    setHealth({
      status: "degraded",
      message: SECRET_RESOLUTION_DISABLED_MESSAGE,
      details: {
        issue: "paperclip-plugin-secret-resolution-disabled",
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    });
    ctx.logger.error("Discord plugin cannot resolve bot token secret; runtime features are disabled", {
      error,
      reference: SECRET_RESOLUTION_ISSUE_URL,
    });
    return undefined;
  }
}
