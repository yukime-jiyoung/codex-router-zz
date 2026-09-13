// Conformance probe. Measures what an endpoint actually accepts, rather than
// trusting what a catalog says about it.
//
//   node probe.mjs --model <slug> [--tier smoke|full] [--dry-run] [--only ID,ID]
//
// Credentials are resolved the way the router resolves them and are never
// printed, logged, or written to an artifact.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OUTCOME, buildRecord, fingerprint, save, scrub, toProfile } from "./record.mjs";
import { SEQUENCES, TESTS, selectTests } from "./catalog.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// tools/compat-probe/ sits two levels below the repository root, so the router
// it probes is the one it ships with unless the caller points elsewhere.
const SOURCE_ROOT = process.env.COMPAT_PROBE_SOURCE_ROOT
  || path.resolve(HERE, "..", "..");
// Same state directory the router itself resolves, and for the same reasons:
// the probe reads the provider's credential from exactly where the router
// would look, so a model that probes clean is a model the router can reach.
const STATE_DIR = process.env.COMPAT_PROBE_STATE_DIR
  || process.env.MODEL_ROUTER_STATE_DIR
  || process.env.CODEX_ROUTER_STATE_DIR
  || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "codex-router");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1]?.startsWith("--") ? true : args[at + 1]);
};
const has = (name) => args.includes(`--${name}`);

const modelSlug = flag("model", "opencode-zen-responses/muse-spark-1.3-contributor-free");
const tier = flag("tier", "smoke");
const only = flag("only", "")?.toString().split(",").filter(Boolean);
const dryRun = has("dry-run");
const withSequences = has("sequences") || tier !== "smoke";

// ── endpoint と資格情報の解決 ────────────────────────────────────
// pathToFileURL, not a hand-built file:// string: prefixing a POSIX root with
// "file:///" produces four slashes and a path that starts "//", which is not
// the same path on every platform. It also escapes a space or a "#" in the
// repository path, which a template literal leaves to break the import.
const registry = await import(
  pathToFileURL(path.join(SOURCE_ROOT, "src", "model-registry.mjs")).href,
);
const model = registry.MODEL_BY_SLUG.get(modelSlug);
if (!model) throw new Error(`unknown model: ${modelSlug}`);
const provider = registry.providerForModel(model);
if (!provider) throw new Error(`no provider for ${modelSlug}`);

function credential() {
  for (const name of provider.credential?.environment ?? []) {
    if (process.env[name]) return process.env[name].trim();
  }
  const file = provider.credential?.file;
  if (file) {
    try { return readFileSync(path.join(STATE_DIR, file), "utf8").trim(); } catch { /* fall through */ }
  }
  const names = (provider.credential?.environment ?? []).join(", ");
  throw new Error(
    `no credential resolved for provider ${provider.id}. `
    + (names ? `Set one of: ${names}. ` : "")
    + `Or place it at ${path.join(STATE_DIR, provider.credential?.file ?? "<credential file>")}.`,
  );
}

const KEY = dryRun ? "" : credential();
const SECRETS = KEY ? [KEY] : [];
const BASE_URL = provider.baseUrl;
// Responses and Chat Completions are different surfaces with different paths.
// The route's own protocol decides which one is probed, so a Chat Completions
// provider is not silently measured against an endpoint it does not serve.
const ENDPOINT_PATH = provider.protocol === "openai-responses" || provider.protocol === undefined
  ? "/responses"
  : "/chat/completions";
const ENDPOINT = {
  fingerprint: fingerprint({ baseUrl: BASE_URL, endpointPath: ENDPOINT_PATH, protocol: provider.protocol, model: model.upstreamModel }),
  base_url_host: (() => { try { return new URL(BASE_URL).host; } catch { return BASE_URL; } })(),
  path: ENDPOINT_PATH,
  protocol: provider.protocol ?? "openai",
};

// ── 送信と解析 ────────────────────────────────────────────────
function parseSse(text) {
  const items = [];
  let completed = null;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") continue;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === "response.output_item.done" && event.item) items.push(event.item);
    if (event.type === "response.completed") completed = event.response;
    if (event.type === "response.incomplete") completed = event.response ?? { status: "incomplete" };
  }
  const output = completed?.output?.length ? completed.output : items;
  const textOut = output
    .filter((item) => item?.type === "message")
    .flatMap((item) => (item.content ?? []).map((c) => c.text ?? ""))
    .join("");
  return { items: output, completed, text: textOut };
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    const output = value.output ?? [];
    const textOut = output
      .filter((item) => item?.type === "message")
      .flatMap((item) => (item.content ?? []).map((c) => c.text ?? ""))
      .join("");
    return { items: output, completed: value, text: textOut };
  } catch { return { items: [], completed: null, text: "" }; }
}

let sent = 0;
async function send(body) {
  const payload = {
    model: model.upstreamModel,
    stream: true,
    store: false,
    // A cap keeps a probe cheap, but it also truncates the very output some
    // effects are read out of -- and applied to the control as well it erases
    // the difference the pair exists to expose. A test that needs room says so.
    max_output_tokens: 256,
    ...body,
  };
  if (payload.max_output_tokens === null) delete payload.max_output_tokens;
  sent += 1;
  const started = Date.now();
  let response;
  try {
    response = await fetch(BASE_URL + ENDPOINT_PATH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Accept: payload.stream === false ? "application/json" : "text/event-stream",
        "Accept-Encoding": "identity",
        "User-Agent": "compat-probe/1.0",
        // OpenCode groups a conversation by this header and rejects a Responses
        // turn without one. It means nothing to other providers, so it travels
        // only where it is understood rather than leaking into every probe.
        ...(provider.id.startsWith("opencode")
          ? { "x-opencode-session": "00000000-0000-4000-8000-000000000001" }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return { status: 0, ms: Date.now() - started, transport: String(error?.message ?? error), parsed: { items: [], completed: null, text: "" }, raw: "" };
  }
  const raw = await response.text();
  const parsed = payload.stream === false ? parseJson(raw) : parseSse(raw);
  return { status: response.status, ms: Date.now() - started, parsed, raw };
}

// 429/5xx は一時的なことがある。間隔を空けて数回だけ試す。
async function sendWithBackoff(body) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await send(body);
    if (last.status !== 429 && last.status < 500 && last.status !== 0) return last;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  return last;
}

// `difference` is the honest shape for most effects. Asking "is the output
// short?" needs a threshold pulled out of the air; asking "is B shorter than A?"
// needs only the pair the test already sends, and it survives a model that is
// simply terse. `effect` stays for the cases where the artifact either appears
// or does not.
function classify(observe, result, control) {
  if (result.status === 0 || result.status >= 500) return OUTCOME.ERROR_UPSTREAM;
  if (result.status >= 400) return OUTCOME.REJECTED;
  if (observe.kind === "acceptance") return OUTCOME.ACCEPTED_HONORED;
  if (observe.kind === "difference") {
    if (!control || control.status >= 400) return OUTCOME.UNOBSERVABLE;
    return observe.differs(control.parsed, result.parsed) ? OUTCOME.ACCEPTED_HONORED : OUTCOME.ACCEPTED_IGNORED;
  }
  return observe.detect(result.parsed) ? OUTCOME.ACCEPTED_HONORED : OUTCOME.ACCEPTED_IGNORED;
}

// Reading the effect on both halves of the pair separates three states a single
// "did B show the effect" cannot: the parameter did something, the endpoint was
// already doing it, or the parameter was discarded. On 2026-09-12 the middle
// case was reported as the last one, and the production log disproved it within
// a minute. A probe that cannot tell them apart will raise that false alarm on
// every endpoint whose default happens to match the request.
function classifyPresence(observe, control, variant) {
  if (variant.status === 0 || variant.status >= 500) return OUTCOME.ERROR_UPSTREAM;
  if (variant.status >= 400) return OUTCOME.REJECTED;
  if (!control || control.status >= 400) return OUTCOME.UNOBSERVABLE;
  const inControl = observe.present(control.parsed);
  const inVariant = observe.present(variant.parsed);
  if (inVariant && !inControl) return OUTCOME.ACCEPTED_HONORED;
  if (inVariant && inControl) return OUTCOME.ACCEPTED_UNCONDITIONAL;
  if (!inVariant && inControl) return OUTCOME.OUTPUT_SHAPE_DIFFERS;
  return OUTCOME.ACCEPTED_IGNORED;
}

function errorDetail(result) {
  if (result.status < 400) return {};
  let param, type;
  try {
    const body = JSON.parse(result.raw);
    param = body?.error?.param; type = body?.error?.type;
  } catch { /* excerpt still carries it */ }
  return { http_status: result.status, error_param: param ?? null, error_type: type ?? null };
}

// ── 実行 ──────────────────────────────────────────────────────
const selected = selectTests({ tier, only });
const sequences = withSequences && !only?.length ? SEQUENCES : [];
const planned = selected.length * 2 + sequences.reduce((n, s) => n + 1 + s.variants.length, 0);

console.log(`endpoint : ${ENDPOINT.base_url_host}${ENDPOINT.path}  (${ENDPOINT.fingerprint})`);
console.log(`model    : ${modelSlug}  →  ${model.upstreamModel}`);
console.log(`tier     : ${tier}   tests: ${selected.length}   sequences: ${sequences.length}`);
console.log(`requests : ${planned} 件（直列、上限256トークン、store=false、ツールは定義するのみで実行しない）`);
if (dryRun) { console.log("\n--dry-run のため送信しません。"); process.exit(0); }
console.log("");

const records = [];

for (const test of selected) {
  const a = await sendWithBackoff(test.a.body());
  const b = await sendWithBackoff(test.b.body());
  // A difference or presence test reads the pair as a whole, so the control has
  // no verdict of its own: it is the baseline the variant is measured against.
  const comparative = test.observe.kind === "difference" || test.observe.kind === "presence";
  const outcomeA = comparative
    ? (a.status >= 400 ? classify({ kind: "acceptance" }, a) : OUTCOME.ACCEPTED_HONORED)
    : classify(test.observe, a);
  const outcomeB = test.observe.kind === "presence"
    ? classifyPresence(test.observe, a, b)
    : classify(test.observe, b, a);

  // A と B が同じなら、その課題ではこの変数は何も変えていない。
  const indistinguishable = outcomeA === outcomeB && test.observe.kind === "effect";
  const record = buildRecord({
    test, endpoint: ENDPOINT, model: modelSlug, accountTier: model.isFree ? "free" : null,
    variantA: { label: test.a.label, outcome: outcomeA, http_status: a.status, ms: a.ms },
    variantB: { label: test.b.label, outcome: outcomeB, http_status: b.status, ms: b.ms,
                excerpt: b.status >= 400 ? scrub(b.raw, SECRETS) : undefined },
    target: {
      verdict: indistinguishable ? OUTCOME.UNOBSERVABLE : outcomeB,
      ...errorDetail(b),
      // Recorded for every shape that has an effect to read, not just `effect`:
      // an observation whose evidence fields are null cannot be re-examined
      // later, which is how a false positive survives a first reading.
      effect_probe: test.observe.describe ?? null,
      effect_observed: test.observe.kind === "presence" ? test.observe.present(b.parsed)
        : test.observe.kind === "effect" ? outcomeB === OUTCOME.ACCEPTED_HONORED : null,
      control_effect_observed: test.observe.kind === "presence" ? test.observe.present(a.parsed)
        : test.observe.kind === "effect" ? outcomeA === OUTCOME.ACCEPTED_HONORED : null,
    },
    notes: indistinguishable
      ? "control and variant behaved identically; the task cannot separate them"
      : null,
  });
  records.push(record);

  // A finding already known and deliberately left alone is not news. Flagging it
  // every run is how a report stops being read.
  record.expected = test.expected ?? null;
  record.is_new = Boolean(test.expected) && record.target.verdict !== test.expected
    ? true
    : !test.expected && record.conclusion !== "CONFORMANT";
  const mark = record.expected && record.target.verdict === record.expected
    ? "="
    : record.target.verdict === OUTCOME.ACCEPTED_UNCONDITIONAL ? "o"
    : { CONFORMANT: "✓", SILENT_DIVERGENCE: "!!", BEHAVIORAL_DIVERGENCE: "!",
        REFERENCE_LENIENT: "~", CONFORMANCE_FAILURE: "x", INCONCLUSIVE: "?",
        DIVERGENCE_UNCONFIRMED: "!" }[record.conclusion] ?? "?";
  console.log(`${mark} ${test.id.padEnd(34)} ${String(outcomeA).padEnd(18)} → ${String(record.target.verdict).padEnd(18)} ${record.conclusion}`);
}

for (const seq of sequences) {
  const elicited = await sendWithBackoff(seq.elicit());
  const produced = elicited.parsed.items.find((item) => item?.type === "function_call");
  if (!produced) {
    console.log(`? ${seq.id.padEnd(34)} モデルがツールを呼ばず、再生の材料が取れませんでした`);
    continue;
  }
  for (const variant of seq.variants) {
    const replayed = await sendWithBackoff(seq.replay(variant.mutate({ ...produced }), seq.tool));
    const outcome = classify({ kind: "acceptance" }, replayed);
    const record = buildRecord({
      test: { ...seq, id: `${seq.id}#${variant.label.replace(/\s+/g, "_")}`,
              feature: `${seq.feature}.${variant.label.replace(/\s+/g, "_")}` },
      endpoint: ENDPOINT, model: modelSlug, accountTier: model.isFree ? "free" : null,
      variantA: { label: "elicited from the model itself", outcome: OUTCOME.ACCEPTED_HONORED, http_status: elicited.status },
      variantB: { label: variant.label, outcome, http_status: replayed.status,
                  excerpt: replayed.status >= 400 ? scrub(replayed.raw, SECRETS) : undefined },
      target: { verdict: outcome, ...errorDetail(replayed), effect_probe: null, effect_observed: null, control_effect_observed: null },
    });
    records.push(record);
    console.log(`${outcome === OUTCOME.REJECTED ? "!" : "✓"} ${(seq.id + "#" + variant.label).padEnd(34)} ${outcome}`);
  }
}

const outDir = path.join(HERE, "observations");
const file = save(records, outDir);
const profile = toProfile(records);
save([profile], path.join(HERE, "profiles"));

console.log(`\n送信 ${sent} 件。観測 ${records.length} 件を保存しました。`);
console.log(`  ${file}`);
const known = records.filter((r) => r.expected && r.target.verdict === r.expected);
const notable = records.filter((r) => r.is_new);
if (known.length) console.log(`\n既知（対処済み・想定どおり） ${known.length} 件`);
if (notable.length) {
  console.log(`\n要注意 ${notable.length} 件:`);
  for (const r of notable) console.log(`  ${r.conclusion.padEnd(24)} ${r.feature}`);
} else {
  console.log("\n新しい発見はありません。");
}
