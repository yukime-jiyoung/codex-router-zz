import { cooldownUntil, parseRateLimitHeaders } from "./rate-limit-headers.mjs";
import {
  rateLimitSnapshotFor,
  readRateLimitSnapshots,
  recordRateLimitSnapshot,
} from "./rate-limit-state.mjs";
import { canonicalProviderId } from "./provider-selection.mjs";

const DEFAULT_RATE_LIMIT_MS = 60_000;
const DEFAULT_QUOTA_LIMIT_MS = 15 * 60_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

// Protocol variants of one subscription share the same upstream allowance.
// opencode Zen is the exception: it shares a credential and selection toggle
// with Go, but it uses the separately billed /zen endpoint. Exhausting Go must
// not disable a route the operator can still pay for through Zen.
export function cooldownScope(providerId) {
  if (providerId === "opencode-zen") return providerId;
  return canonicalProviderId(providerId);
}

function boundedFuture(timestamp, now) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= now) return undefined;
  return Math.min(value, now + MAX_COOLDOWN_MS);
}

// Subscription APIs often put the only useful reset signal in the error body
// (for example "Resets in 1hr 20min") instead of Retry-After. Reuse the same
// duration grammar as response headers, but require reset/refill wording so an
// unrelated duration in an error cannot open a circuit.
export function quotaResetAt(bodyText, now = Date.now()) {
  const text = typeof bodyText === "string" ? bodyText : "";
  const phrase = /(?:reset(?:s|ting)?|refresh(?:es|ed)?|refill(?:s|ed)?)\s+in\s+([^.,;"}\n]+)/i.exec(text)?.[1];
  if (!phrase) return undefined;
  let durationMs = 0;
  let matched = false;
  const units = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  for (const match of phrase.matchAll(units)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(value)) continue;
    matched = true;
    if (unit.startsWith("h")) durationMs += value * 3_600_000;
    else if (unit.startsWith("m")) durationMs += value * 60_000;
    else durationMs += value * 1_000;
  }
  return matched ? now + Math.round(durationMs) : undefined;
}

export function activeProviderCooldown(providerId, { now = Date.now() } = {}) {
  const scope = cooldownScope(providerId);
  const snapshot = rateLimitSnapshotFor(scope);
  const until = boundedFuture(Date.parse(cooldownUntil(snapshot) || ""), now);
  if (until === undefined) return undefined;
  return {
    scope,
    until,
    retryAfterSeconds: Math.max(1, Math.ceil((until - now) / 1000)),
    reason: snapshot?.reason === "quota" ? "quota" : "rate_limit",
  };
}

export function temporarilyUnavailableSubagentSlugs(models, { now = Date.now() } = {}) {
  const unavailable = new Set();
  for (const model of models || []) {
    const cooldown = activeProviderCooldown(model?.provider, { now });
    if (cooldown?.reason === "quota") unavailable.add(String(model.slug));
  }
  return unavailable;
}

export function nextQuotaCooldownExpiry({ now = Date.now() } = {}) {
  let next;
  for (const [scope, snapshot] of Object.entries(readRateLimitSnapshots())) {
    if (snapshot?.reason !== "quota") continue;
    const cooldown = activeProviderCooldown(scope, { now });
    if (!cooldown) continue;
    next = next === undefined ? cooldown.until : Math.min(next, cooldown.until);
  }
  return next;
}

export function recordProviderCooldown({
  providerId,
  status,
  bodyText,
  headers,
  translatedType,
  now = Date.now(),
}) {
  const headerSnapshot = parseRateLimitHeaders(headers, { now });
  const headerUntil = boundedFuture(Date.parse(cooldownUntil(headerSnapshot) || ""), now);
  const quota = translatedType === "billing_error";
  const bodyUntil = quota ? boundedFuture(quotaResetAt(bodyText, now), now) : undefined;

  let until = Math.max(headerUntil || 0, bodyUntil || 0);
  if (!until && quota) until = now + DEFAULT_QUOTA_LIMIT_MS;
  if (!until && Number(status) === 429) until = now + DEFAULT_RATE_LIMIT_MS;
  until = boundedFuture(until, now);
  if (until === undefined) return undefined;

  const scope = cooldownScope(providerId);
  recordRateLimitSnapshot(
    scope,
    {
      ...(headerSnapshot || {}),
      retryAt: new Date(until).toISOString(),
      reason: quota ? "quota" : "rate_limit",
    },
    { at: now },
  );
  return activeProviderCooldown(scope, { now });
}

export function cooldownErrorPayload({ cooldown, modelName, providerName }) {
  const reset = new Date(cooldown.until).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const quota = cooldown.reason === "quota";
  return {
    error: {
      message: quota
        ? `${providerName} usage is exhausted for ${modelName}. Codex Router will not contact this subscription again until ${reset}; switch models or wait for the allowance to reset.`
        : `${providerName} is rate-limiting ${modelName}. Codex Router will not contact it again for about ${cooldown.retryAfterSeconds}s.`,
      type: quota ? "billing_error" : "rate_limit_error",
      param: null,
      code: quota ? "402" : "429",
    },
  };
}
