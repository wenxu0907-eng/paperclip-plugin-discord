import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DISCORD_API_BASE, METRIC_NAMES } from "./constants.js";

const GATEWAY_VERSION = "10";
const GATEWAY_ENCODING = "json";
const MAX_CONSECUTIVE_FAILURES = 5;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_RECONNECT_MS = 5000;
// Base delay for the exponential-backoff schedule applied to every failed
// reconnect (including Invalid Session op 9). Discord force-resets a bot token
// once it opens ~1000 gateway sessions in a day, so a persistently failing
// session must back off aggressively rather than retry every 1-5s.
const BASE_BACKOFF_MS = 2000;
const GUILD_INTENT = 1;
const GUILD_MESSAGES_INTENT = 512;
const MESSAGE_CONTENT_INTENT = 32768;

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

interface ReadyEvent {
  session_id: string;
  resume_gateway_url: string;
}

interface InteractionCreateEvent {
  id: string;
  token: string;
  type: number;
  // Discord's application (bot) id, needed to address the follow-up webhook
  // when a slash command is deferred.
  application_id?: string;
  data?: Record<string, unknown>;
  member?: { user: { username: string } };
  guild_id?: string;
  channel_id?: string;
}

export interface MessageCreateEvent {
  id: string;
  channel_id: string;
  content: string;
  author: { id: string; username: string; bot?: boolean };
  message_reference?: {
    message_id: string;
    channel_id: string;
    guild_id?: string;
  };
}

type InteractionHandler = (interaction: InteractionCreateEvent) => Promise<unknown>;
type MessageHandler = (message: MessageCreateEvent) => Promise<void>;

export interface GatewayOptions {
  listenForMessages?: boolean;
  includeMessageContent?: boolean;
}

export async function respondViaCallback(
  ctx: PluginContext,
  interactionId: string,
  interactionToken: string,
  responseData: unknown,
): Promise<void> {
  const url = `${DISCORD_API_BASE}/interactions/${interactionId}/${interactionToken}/callback`;
  try {
    // Use native fetch instead of ctx.http.fetch because Discord returns 204
    // on success.  The SDK's http.fetch reconstructs a Response object via
    // `new Response(body, { status })` which throws when the body is non-null
    // and the status is a null-body status (204).  Native fetch handles this
    // correctly and the interaction callback does not need SDK audit tracing.
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(responseData),
    });
    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn("Interaction callback failed", {
        status: response.status,
        body: text,
      });
    }
  } catch (error) {
    ctx.logger.error("Interaction callback error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// After a slash command is deferred (see the INTERACTION_CREATE handler), the
// real response is delivered by editing the original (deferred) message via the
// interaction follow-up webhook. The interaction token is valid for 15 minutes,
// so the underlying work (resolve company/project/agent, create the issue) is no
// longer racing Discord's hard 3-second callback deadline.
export async function editDeferredResponse(
  ctx: PluginContext,
  applicationId: string,
  interactionToken: string,
  responseData: unknown,
): Promise<void> {
  // A handler builds an interaction *callback* payload — `{ type, data: {...} }`.
  // The follow-up webhook takes the message body directly, so unwrap `.data`.
  const message =
    responseData && typeof responseData === "object" && "data" in responseData
      ? (responseData as { data: unknown }).data
      : responseData;
  const url = `${DISCORD_API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message ?? {}),
    });
    if (!response.ok) {
      const text = await response.text();
      ctx.logger.warn("Interaction follow-up edit failed", {
        status: response.status,
        body: text,
      });
    }
  } catch (error) {
    ctx.logger.error("Interaction follow-up edit error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function connectGateway(
  ctx: PluginContext,
  token: string,
  onInteraction: InteractionHandler,
  onMessage?: MessageHandler,
  options: GatewayOptions = {},
): Promise<{ close: () => void }> {
  if (typeof WebSocket === "undefined") {
    ctx.logger.warn(
      "WebSocket is not available in this environment (requires Node.js >= 21). " +
      "Gateway connection disabled — interactions will only work via webhook.",
    );
    return { close: () => {} };
  }

  const gatewayUrl = await getGatewayUrl(ctx, token);
  if (!gatewayUrl) {
    ctx.logger.warn("Could not get Gateway URL, interactions will only work via webhook");
    return { close: () => {} };
  }

  let ws: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let heartbeatAckTimeout: ReturnType<typeof setTimeout> | null = null;
  let sequence: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let closed = false;
  let consecutiveFailures = 0;
  let lastHeartbeatIntervalMs = 41250;
  const listenForMessages = options.listenForMessages ?? Boolean(onMessage);
  const includeMessageContent = options.includeMessageContent ?? listenForMessages;
  const intents =
    GUILD_INTENT |
    (listenForMessages ? GUILD_MESSAGES_INTENT : 0) |
    (includeMessageContent ? MESSAGE_CONTENT_INTENT : 0);

  function getReconnectDelay(): number {
    // Exponential backoff with full jitter, capped at MAX_BACKOFF_MS. Previously
    // this returned a flat DEFAULT_RECONNECT_MS until MAX_CONSECUTIVE_FAILURES,
    // and the Invalid Session (op 9) path ignored it entirely and retried every
    // 1-5s. A session that could never succeed (revoked token, or a shared token
    // being evicted by another company's worker) therefore hammered IDENTIFY and
    // tripped Discord's ~1000-sessions/day reset. Backoff now grows on every
    // failure so a stuck worker cannot storm the gateway.
    const exp = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** Math.min(consecutiveFailures, 10),
    );
    // Full jitter: random point in [exp/2, exp] to de-correlate concurrent workers.
    return Math.floor(exp / 2 + Math.random() * (exp / 2));
  }

  // ws.send throws InvalidStateError ("Sent before connected") if the socket
  // is CONNECTING (0), CLOSING (2), or CLOSED (3). The heartbeat timer can
  // outlive the socket it was scheduled against (e.g. after onclose fires
  // between the interval being set and the next tick), so guard every send.
  // Returns true if the frame was actually sent.
  function safeSend(payload: object): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      ctx.logger.warn("Gateway ws.send failed", {
        readyState: ws.readyState,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function connect(url: string, resume: boolean) {
    if (closed) return;

    const wsUrl = `${url}/?v=${GATEWAY_VERSION}&encoding=${GATEWAY_ENCODING}`;
    ctx.logger.info("Connecting to Discord Gateway", { resume, consecutiveFailures });

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ctx.logger.info("Gateway WebSocket connected");
    };

    ws.onmessage = async (event) => {
      const payload = JSON.parse(String(event.data)) as GatewayPayload;

      if (payload.s !== null) {
        sequence = payload.s;
      }

      switch (payload.op) {
        case 10: {
          const heartbeatMs = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
          lastHeartbeatIntervalMs = heartbeatMs;
          startHeartbeat(heartbeatMs);

          if (resume && sessionId) {
            safeSend({
              op: 6,
              d: { token: `Bot ${token}`, session_id: sessionId, seq: sequence },
            });
          } else {
            safeSend({
              op: 2,
              d: {
                token: `Bot ${token}`,
                intents,
                properties: {
                  os: "linux",
                  browser: "paperclip-plugin-discord",
                  device: "paperclip-plugin-discord",
                },
              },
            });
          }
          break;
        }

        case 0: {
          if (payload.t === "READY") {
            const ready = payload.d as ReadyEvent;
            sessionId = ready.session_id;
            resumeUrl = ready.resume_gateway_url;
            consecutiveFailures = 0;
            ctx.logger.info("Gateway ready", { sessionId });
          }

          if (payload.t === "RESUMED") {
            consecutiveFailures = 0;
            ctx.logger.info("Gateway resumed successfully");
          }

          if (payload.t === "INTERACTION_CREATE") {
            const interaction = payload.d as InteractionCreateEvent;
            try {
              // Slash commands (type 2) can run work that easily exceeds
              // Discord's hard 3-second callback deadline — e.g. `/clip assign`
              // resolves the company, project, and agent and then creates the
              // issue over the network. When that happens Discord invalidates
              // the token (10062) and shows the user "The application did not
              // respond" even though the work succeeded, and the real result
              // never reaches them. Acknowledge immediately with a deferred
              // response (type 5), then deliver the result by editing the
              // deferred message. PING (type 1) must answer with type 1 and
              // autocomplete (type 4) must answer with type 8 — neither is
              // deferrable — so they keep the direct-callback path.
              if (interaction.type === 2 && interaction.application_id) {
                await respondViaCallback(ctx, interaction.id, interaction.token, {
                  type: 5,
                  data: { flags: 64 },
                });
                const response = await onInteraction(interaction);
                await editDeferredResponse(
                  ctx,
                  interaction.application_id,
                  interaction.token,
                  response,
                );
              } else {
                const response = await onInteraction(interaction);
                await respondViaCallback(ctx, interaction.id, interaction.token, response);
              }
            } catch (error) {
              ctx.logger.error("Gateway interaction handler error", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          if (payload.t === "MESSAGE_CREATE" && onMessage) {
            const message = payload.d as MessageCreateEvent;
            try {
              await onMessage(message);
            } catch (error) {
              ctx.logger.error("Gateway message handler error", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          break;
        }

        case 1: {
          safeSend({ op: 1, d: sequence });
          break;
        }

        case 7: {
          ctx.logger.info("Gateway requested reconnect");
          cleanup();
          await ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1);
          connect(resumeUrl ?? url, true);
          break;
        }

        case 9: {
          const resumable = payload.d as boolean;
          ctx.logger.info("Invalid session", { resumable });
          cleanup();
          if (!resumable) {
            sessionId = null;
            sequence = null;
          }
          consecutiveFailures++;
          await ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1);
          // Use the shared exponential-backoff schedule. A repeatedly-invalid
          // session (e.g. shared-token eviction) must not re-IDENTIFY every 1-5s.
          const delay = getReconnectDelay();
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            ctx.logger.error("Gateway invalid-session loop, backing off", {
              consecutiveFailures,
              delayMs: delay,
            });
          }
          setTimeout(() => connect(url, resumable), delay);
          break;
        }

        case 11: {
          if (heartbeatAckTimeout) {
            clearTimeout(heartbeatAckTimeout);
            heartbeatAckTimeout = null;
          }
          break;
        }
      }
    };

    ws.onclose = (event) => {
      ctx.logger.info("Gateway WebSocket closed", { code: event.code, reason: event.reason });
      cleanup();
      if (!closed && event.code !== 4004) {
        consecutiveFailures++;
        ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1).catch(() => {});
        const delay = getReconnectDelay();
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          ctx.logger.error("Gateway reconnection failing repeatedly, backing off", {
            consecutiveFailures,
            delayMs: delay,
          });
        }
        setTimeout(() => connect(resumeUrl ?? url, sessionId !== null), delay);
      }
    };

    ws.onerror = (event) => {
      ctx.logger.warn("Gateway WebSocket error", {
        error: String(event),
      });
    };
  }

  function startHeartbeat(intervalMs: number) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (heartbeatAckTimeout) clearTimeout(heartbeatAckTimeout);

    const sendHeartbeat = () => {
      // If the socket isn't OPEN, skip this tick entirely. Don't schedule an
      // ack timeout for a frame we never sent — onclose will trigger a
      // reconnect, which is the correct recovery path. Sending here without
      // the guard is what caused the long-lived `InvalidStateError: Sent
      // before connected` crash that took the worker down on 2026-05-12.
      const sent = safeSend({ op: 1, d: sequence });
      if (!sent) return;
      heartbeatAckTimeout = setTimeout(() => {
        ctx.logger.warn("Heartbeat ACK not received, forcing reconnect");
        cleanup();
        consecutiveFailures++;
        ctx.metrics.write(METRIC_NAMES.gatewayReconnections, 1).catch(() => {});
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close(4000, "Heartbeat timeout");
        }
      }, intervalMs * 2);
    };

    const jitter = Math.random() * intervalMs;
    setTimeout(() => {
      sendHeartbeat();
      heartbeatInterval = setInterval(sendHeartbeat, intervalMs);
    }, jitter);
  }

  function cleanup() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (heartbeatAckTimeout) {
      clearTimeout(heartbeatAckTimeout);
      heartbeatAckTimeout = null;
    }
  }

  connect(gatewayUrl, false);

  return {
    close: () => {
      closed = true;
      cleanup();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "Plugin shutting down");
      }
    },
  };
}

async function getGatewayUrl(ctx: PluginContext, token: string): Promise<string | null> {
  try {
    const response = await ctx.http.fetch(`${DISCORD_API_BASE}/gateway/bot`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      ctx.logger.warn("Failed to get Gateway URL", { status: response.status });
      return null;
    }
    const data = (await response.json()) as { url: string };
    return data.url;
  } catch (error) {
    ctx.logger.error("Gateway URL fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
