/**
 * Fetch wrapper for Paperclip API calls.
 *
 * `ctx.http.fetch` (the plugin-SDK host client) rejects requests whose
 * resolved IPs fall in private/reserved ranges (e.g. 127.0.0.1).  The
 * Paperclip API server often runs on localhost during local development,
 * so those calls fail with:
 *
 *   "All resolved IPs for localhost are in private/reserved ranges"
 *
 * Native `fetch` has no such restriction, so we use it for all calls
 * that target the Paperclip base URL.
 *
 * Auth: when Paperclip is deployed in `authenticated` mode (the default
 * for public deployments), server routes that call `assertBoard(req)`
 * (approvals, board mutations, etc.) require an Authorization: Bearer
 * header carrying a board API key. Pass `apiKey` to attach it. In
 * `local_trusted` deployments unauthenticated requests are implicitly
 * promoted to `board`, so `apiKey` can be omitted.
 *
 * Throws on non-2xx responses with a `PaperclipFetchError` carrying
 * `status` + `headers` so `withRetry` can recognize retryable statuses
 * (429/500/502/503) without callers needing to call `throwOnRetryableStatus`
 * inside their `withRetry` callback.
 */
export class PaperclipFetchError extends Error {
  status: number;
  headers: Headers;
  constructor(message: string, status: number, headers: Headers) {
    super(message);
    this.name = "PaperclipFetchError";
    this.status = status;
    this.headers = headers;
  }
}

export async function paperclipFetch(
  url: string,
  init?: RequestInit,
  apiKey?: string,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "<unreadable>");
    throw new PaperclipFetchError(
      `paperclipFetch ${init?.method ?? "GET"} ${url} → ${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
      response.status,
      response.headers,
    );
  }
  return response;
}
