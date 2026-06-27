import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { paperclipFetch, PaperclipFetchError } from "../src/paperclip-fetch.js";

describe("paperclipFetch", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns the Response unchanged on 2xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', { status: 200, statusText: "OK" }),
    );
    const r = await paperclipFetch("http://x/y", { method: "GET" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("throws PaperclipFetchError with status + body on 401", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("Malformed JWT: expected 3 parts", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      paperclipFetch("http://x/y", { method: "POST" }, "test-key"),
    ).rejects.toThrow(/401 Unauthorized.*Malformed JWT/);
    try {
      await paperclipFetch("http://x/y", { method: "POST" }, "test-key");
    } catch (err) {
      expect(err).toBeInstanceOf(PaperclipFetchError);
      expect((err as PaperclipFetchError).status).toBe(401);
    }
  });

  it("attaches status + headers so withRetry can detect retryable statuses", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": "2" },
      }),
    );
    try {
      await paperclipFetch("http://x/y");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PaperclipFetchError);
      const pErr = err as PaperclipFetchError;
      expect(pErr.status).toBe(429);
      expect(pErr.headers.get("Retry-After")).toBe("2");
    }
  });

  it("attaches Bearer auth header when apiKey is provided", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    global.fetch = fetchSpy;
    await paperclipFetch("http://x/y", {}, "my-api-key");
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer my-api-key");
  });

  it("does not overwrite an existing Authorization header", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    global.fetch = fetchSpy;
    await paperclipFetch(
      "http://x/y",
      { headers: { Authorization: "Bearer pre-set" } },
      "my-api-key",
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer pre-set");
  });

  it("truncates very long error bodies to keep error messages bounded", async () => {
    const longBody = "x".repeat(5000);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(longBody, { status: 500, statusText: "Internal Server Error" }),
    );
    try {
      await paperclipFetch("http://x/y");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg.length).toBeLessThan(500);
      expect(msg).toMatch(/500 Internal Server Error/);
    }
  });
});
