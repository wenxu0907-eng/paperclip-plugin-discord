/**
 * Secret-reference normalization (COM-430).
 *
 * Paperclip hardened the plugin secrets contract: `ctx.secrets.resolve()` now
 * accepts ONLY the object form `{ type: "secret_ref", secretId, version? }` and
 * rejects a bare secret UUID with
 *
 *   Invalid secret reference for plugin: <uuid>. Use { type: "secret_ref", secretId, version? }
 *
 * Existing company configs (and this plugin's own manifest) still carry the
 * legacy bare-UUID string. Normalizing here means both shapes keep working on
 * old and new hosts, and the plugin does not need a config migration to boot.
 */

export interface SecretRefBinding {
  type: "secret_ref";
  secretId: string;
  version?: string;
}

/** A secret reference as it may appear in stored plugin config. */
export type SecretRefValue = string | SecretRefBinding | null | undefined;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSecretRefBinding(value: unknown): value is SecretRefBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === "secret_ref" &&
    typeof record.secretId === "string" &&
    UUID_RE.test(record.secretId.trim())
  );
}

/** True when the config field holds something that looks like a secret reference. */
export function hasSecretRef(value: SecretRefValue): boolean {
  if (isSecretRefBinding(value)) return true;
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Convert a stored config value into the shape `ctx.secrets.resolve()` expects.
 *
 * - `{ type: "secret_ref", ... }` is passed through (already canonical).
 * - A bare UUID is upgraded to the object form the host now requires.
 * - Any other non-empty string is passed through unchanged, so hosts and test
 *   doubles that accept opaque reference strings keep working.
 * - Empty/absent values yield `null` — nothing to resolve.
 */
export function normalizeSecretRef(value: SecretRefValue): SecretRefBinding | string | null {
  if (isSecretRefBinding(value)) {
    const secretId = value.secretId.trim();
    return value.version ? { type: "secret_ref", secretId, version: value.version } : { type: "secret_ref", secretId };
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (UUID_RE.test(trimmed)) return { type: "secret_ref", secretId: trimmed };
  return trimmed;
}

/** Human-readable rendering for logs. Never includes a resolved secret value. */
export function describeSecretRef(value: SecretRefValue): string {
  if (isSecretRefBinding(value)) return `secret_ref:${value.secretId}`;
  if (typeof value === "string" && value.trim().length > 0) return `legacy:${value.trim()}`;
  return "<empty>";
}
