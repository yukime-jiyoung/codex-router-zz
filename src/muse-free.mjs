import { decodeCompaction, renderCompactionValue } from "./compaction-checkpoint.mjs";
// Exact opt-in route. Paid Muse and other OpenCode providers keep their policy.
export const MUSE_FREE_ID = "muse-spark-1.3-contributor-free";
const REASONING_PREFIX = "rs_musefree_";

// Never quieted: these two guards are the only local 400s on this route, and
// without a line here an operator sees an HTTP 400 with no way to tell which
// one produced it -- which is exactly what happened on the first production
// turn (2026-09-10T14:00:14Z, refused inside the router, invisible to the
// user, cause unrecoverable after the fact). Shapes and key names only: no
// conversation text, tool output, header value, or credential is written.
function refuse(code, message, detail) {
  process.stderr.write(`${JSON.stringify({ refused: "muse-free", code, ...detail })}\n`);
  throw Object.assign(new Error(message), { status: 400, code });
}

// Keep the original opaque state in Codex's history, but mark its origin so
// a later native turn never mistakes a Zen token for an OpenAI token.
export function museFreeOutputMarker() {
  const ids = new Map();
  return (payload) => {
    const mark = (item) => {
      if (typeof item?.id !== "string") return;
      const reasoning = item.type === "reasoning";
      // Zen emitted an assistant message with an rs_ ID. Native Responses
      // rejects that message on replay even when its full content is present.
      const message = item.type === "message" && item.id.startsWith("rs_");
      if (!reasoning && !message) return;
      const original = item.id;
      const marked = (reasoning ? REASONING_PREFIX : "msg_musefree_") + Buffer.from(original).toString("base64url");
      ids.set(original, marked);
      item.id = marked;
    };
    mark(payload.item);
    for (const item of payload.response?.output ?? payload.output ?? []) mark(item);
    if (ids.has(payload.item_id)) payload.item_id = ids.get(payload.item_id);
    return payload;
  };
}

export function museFreePortableInput(input, { native = false } = {}) {
  if (!Array.isArray(input)) return input;
  return input.flatMap((item) => {
    if (item?.type !== "reasoning" || (native && !(typeof item.id === "string" && item.id.startsWith(REASONING_PREFIX)))) return [item];
    // Summaries are visible content. Internal ciphertext is not portable.
    // Unknown summary shapes fail the existing preflight instead of losing text.
    const emptyContent = item.content == null || (Array.isArray(item.content) && item.content.length === 0);
    const unexpectedKeys = Object.keys(item).filter(k => !["id", "type", "status", "encrypted_content", "summary", "content", "internal_chat_message_metadata_passthrough"].includes(k));
    const badSummary = !Array.isArray(item.summary) || item.summary.some(p => p?.type !== "summary_text" || typeof p.text !== "string" || Object.keys(p).some(k => !["type", "text"].includes(k)));
    if (!emptyContent || unexpectedKeys.length || badSummary) {
      refuse("muse_free_nonportable_history", "Muse Free reasoning has an unsupported summary shape; no history was discarded.",
        { reason: "reasoning_summary_shape", contentPresent: !emptyContent, unexpectedKeys, badSummary, marked: typeof item.id === "string" && item.id.startsWith(REASONING_PREFIX) });
    }
    const text = item.summary.map(p => p.text).join("\n");
    return text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] : [];
  });
}
export function isMuseFree(model) {
  return model?.provider === "opencode-zen-responses" && model.upstreamModel === MUSE_FREE_ID;
}

export function museFreeSessionId(headers) {
  // Only the explicit thread header is accepted until real Desktop traffic
  // establishes the lifetime of session-id/session_id. Never guess from text.
  const value = headers?.["thread-id"];
  if (typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return value.toLowerCase();
  // Which other id-bearing header names arrived, so the next occurrence says
  // whether Codex sent an id under a name `threadIdFromHeaders` accepts and
  // this exact route deliberately does not. Names only, never values.
  refuse("muse_free_thread_id_required", "Muse Free requires a stable Codex thread-id header; no session ID was generated.",
    { threadHeader: value === undefined ? "absent" : "unusable",
      otherIdHeadersPresent: ["session-id", "session_id", "x-codex-parent-thread-id", "x-codex-turn-metadata", "x-codex-window-id"]
        .filter(name => headers?.[name] !== undefined) });
}

export function museFreeHeaders(requestHeaders, apiKey, version) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": `codex-router/${version}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Accept-Encoding": "identity",
    "x-opencode-session": museFreeSessionId(requestHeaders),
  };
}

export function museFreePreflight(payload, headers) {
  museFreeSessionId(headers);
  payload.input = museFreePortableInput(payload.input);
  if (Array.isArray(payload.input)) payload.input = payload.input.map(item =>
    item?.type === "compaction" && decodeCompaction(item.encrypted_content)
      ? {type:"message", role:"assistant", content:[{type:"output_text", text:renderCompactionValue(item.encrypted_content)}]}
      : item);

  // The path is carried alongside each value so the refusal can say where the
  // opaque reference sat (for example `input.7.summary.0`) instead of only that
  // one existed somewhere. Keys and item types only, never their content.
  const pending = [[{previous_response_id: payload.previous_response_id}, "payload"], [payload.input, "input"]];
  while (pending.length) {
    const [item, path] = pending.pop();
    if (!item || typeof item !== "object") continue;
    const reason = item.previous_response_id ? "previous_response_id"
      : item.encrypted_content ? "encrypted_content"
      : item.type === "item_reference" ? "item_reference"
      : undefined;
    if (reason) {
      refuse("muse_free_nonportable_history", "Muse Free cannot safely replay opaque response references or encrypted history. Portable history must be supplied; no content was discarded or sent to another model.",
        { reason, at: path, itemType: typeof item.type === "string" ? item.type : undefined });
    }
    for (const [key, value] of Object.entries(item)) pending.push([value, `${path}.${key}`]);
  }
}
