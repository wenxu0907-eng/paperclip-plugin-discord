import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Lazy company-ID resolver — avoids startup-time API calls that can crash
 * worker activation. The resolved value is cached after the first successful call.
 *
 * Multi-company fix: check `company_default` instance state (written by
 * `/clip connect`) before falling back to list-based resolution. The
 * connected company is NOT cached so that `/clip connect` changes take effect
 * immediately without restarting the plugin.
 */
let _cachedCompanyId: string | null = null;

export async function resolveCompanyId(ctx: PluginContext): Promise<string> {
  // Check if a guild-level default was set via /clip connect — always re-read
  // so that switching companies works without a plugin restart.
  try {
    const connected = (await ctx.state.get({ scopeKind: "instance", stateKey: "company_default" })) as { companyId?: string } | null | undefined;
    if (connected?.companyId) {
      return connected.companyId;
    }
  } catch {
    // state API unavailable at this call site — fall through to list-based resolution
  }

  if (_cachedCompanyId) return _cachedCompanyId;
  try {
    const companies = await ctx.companies.list({ limit: 1 });
    if (companies.length > 0) {
      _cachedCompanyId = companies[0].id;
      return _cachedCompanyId;
    }
  } catch (err) {
    ctx.logger.warn("Failed to resolve company ID, falling back to 'default'", { error: String(err) });
  }
  return "default";
}

/** Reset cached company ID (for testing). */
export function _resetCompanyIdCache(): void {
  _cachedCompanyId = null;
  _channelCompanyCache.clear();
}

// ---------------------------------------------------------------------------
// Channel-scoped company resolution
//
// A SINGLE plugin worker serves every company's Discord channels over one
// gateway connection, so an incoming slash-command / autocomplete interaction
// can originate from ANY company's channel. Resolving the company from a shared
// instance-scope default (`company_default`, set once via `/clip connect`) is
// therefore wrong: it makes every channel — regardless of which company owns it
// — resolve to that one default company (e.g. the `agent:` autocomplete in the
// Executive Assistant channel listing another company's agents, and `/clip
// assign` creating the task under the wrong company).
//
// Each company's Discord config carries a distinct `defaultChannelId` (plus an
// optional `companyChannels` map and a per-company `discord-channel` state
// override). We map the interaction's `channel_id` back to the owning company
// by scanning per-company scoped config, and only fall back to the global
// default resolution when no channel matches (e.g. a DM or an unmapped channel).
// ---------------------------------------------------------------------------
type ScopedConfigGet = (params?: { companyId?: string }) => Promise<Record<string, unknown>>;

const _channelCompanyCache = new Map<string, string>();

function normId(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * Resolve the company that owns the Discord channel an interaction came from.
 * Falls back to {@link resolveCompanyId} when the channel is unknown/unmapped.
 * Successful channel→company resolutions are cached (config changes trigger a
 * worker restart, which clears the cache).
 */
export async function resolveCompanyIdForChannel(
  ctx: PluginContext,
  channelId?: string,
): Promise<string> {
  const wanted = normId(channelId);
  if (!wanted) return resolveCompanyId(ctx);

  const cached = _channelCompanyCache.get(wanted);
  if (cached) return cached;

  try {
    const scopedConfigGet = ctx.config.get as unknown as ScopedConfigGet;
    const companies = await ctx.companies.list();
    for (const company of companies) {
      const companyId = company?.id;
      if (!companyId) continue;
      try {
        // Highest-precedence: a per-company channel override set at runtime via
        // `/clip connect-channel` (stored as company-scoped `discord-channel` state).
        const override = await ctx.state.get({
          scopeKind: "company",
          scopeId: companyId,
          stateKey: "discord-channel",
        });
        if (normId(override) === wanted) {
          _channelCompanyCache.set(wanted, companyId);
          return companyId;
        }

        const cfg = (await scopedConfigGet({ companyId })) ?? {};
        const channelCandidates: unknown[] = [cfg.defaultChannelId];
        const companyChannels = cfg.companyChannels as Record<string, string> | undefined;
        if (companyChannels) channelCandidates.push(...Object.values(companyChannels));

        if (channelCandidates.some((c) => normId(c) === wanted)) {
          _channelCompanyCache.set(wanted, companyId);
          return companyId;
        }
      } catch {
        // Skip a company whose config can't be loaded; keep scanning others.
      }
    }
  } catch (err) {
    ctx.logger.warn("Failed to resolve company by channel; falling back to default", {
      channelId: wanted,
      error: String(err),
    });
  }

  return resolveCompanyId(ctx);
}
