// The test catalog. Every entry here exists because it broke production or
// because the research said the class it belongs to is invisible to status-code
// testing. Nothing was added because it seemed like a good idea.
//
// A test is a metamorphic pair: A and B differ in exactly one place. If A and B
// come back the same, the variable under test did nothing, which is the only way
// to tell "supported" from "quietly discarded".

const TOOL = {
  type: "function",
  name: "probe_list_sites",
  description: "List sites. Takes no arguments.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

// Two properties, one of them optional. The pair below varies only whether
// `required` names both.
const OPTIONAL_ARG_TOOL = (required) => ({
  type: "function",
  name: "probe_search",
  description: "Search with an optional limit.",
  strict: true,
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required,
    additionalProperties: false,
  },
});

const ask = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const said = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const call = (args, id = "probe_c1") => ({
  type: "function_call", call_id: id, name: TOOL.name, arguments: args,
});
const result = (id = "probe_c1", output = "[]") => ({
  type: "function_call_output", call_id: id, output,
});

const SHORT = "OK とだけ答えてください。";

// Acceptance: the endpoint either takes the body or refuses it. No effect to
// observe beyond the status, so a 200 is `accepted_honored` by definition.
const acceptance = { kind: "acceptance" };

// Effect: the endpoint took the body. Whether it did anything with it has to be
// read out of the response, or the test cannot tell acceptance from indifference.
const effect = (describe, detect) => ({ kind: "effect", describe, detect });

// Difference: the effect is visible only by comparing the pair. Preferred over
// `effect` whenever an absolute test would need a threshold invented for it.
const difference = (describe, differs) => ({ kind: "difference", describe, differs });

// Presence: the artifact is either in the response or it is not, read on both
// halves of the pair. This is the only shape that can say "the endpoint was
// already doing it" instead of accusing it of discarding the parameter.
const presence = (describe, present) => ({ kind: "presence", describe, present });

export const TESTS = [
  // ── 8-1 本番障害から導かれたもの ────────────────────────────────
  {
    id: "T_TOOL_STRICT_REQUIRED_001",
    feature: "responses.tools.function.strict.required_omits_optional",
    reliability: "S", tier: "smoke",
    // OpenAI documents strict Structured Outputs as requiring every property in
    // `required`, so a refusal here may be conformant rather than divergent.
    // Recorded as such instead of being turned into a workaround.
    spec: "required_rejection",
    specSource: "https://developers.openai.com/api/docs/guides/structured-outputs",
    observe: acceptance,
    a: { label: "required names every property", body: () => ({ tools: [OPTIONAL_ARG_TOOL(["query", "limit"])], input: [ask(SHORT)] }) },
    b: { label: "required omits the optional one", body: () => ({ tools: [OPTIONAL_ARG_TOOL(["query"])], input: [ask(SHORT)] }) },
  },
  {
    id: "T_TOOL_CHOICE_NAMED_001",
    feature: "responses.tool_choice.named",
    reliability: "S", tier: "smoke", spec: "unspecified",
    expected: "rejected",   // 実測 2026-09-11。requestProfile auto-tool-choice で対処済み
    observe: acceptance,
    a: { label: 'tool_choice "auto"', body: () => ({ tools: [TOOL], tool_choice: "auto", input: [ask(SHORT)] }) },
    b: { label: "tool_choice named", body: () => ({ tools: [TOOL], tool_choice: { type: "function", name: TOOL.name }, input: [ask(SHORT)] }) },
  },
  {
    id: "T_TOOL_CHOICE_NONE_001",
    feature: "responses.tool_choice.none",
    reliability: "S", tier: "smoke", spec: "unspecified",
    expected: "rejected",   // 実測 2026-09-11。normalizeAutoToolChoice は "none" を書き換えない（未対処）
    observe: acceptance,
    a: { label: 'tool_choice "auto"', body: () => ({ tools: [TOOL], tool_choice: "auto", input: [ask(SHORT)] }) },
    b: { label: 'tool_choice "none"', body: () => ({ tools: [TOOL], tool_choice: "none", input: [ask(SHORT)] }) },
  },
  {
    id: "T_TOOL_CUSTOM_001",
    feature: "responses.tools.custom_freeform",
    reliability: "S", tier: "smoke", spec: "unspecified",
    expected: "rejected",   // 実測 2026-09-11。bridgeCustomTools が関数ツールへ変換して対処済み
    observe: acceptance,
    a: { label: "function tool", body: () => ({ tools: [TOOL], input: [ask(SHORT)] }) },
    b: { label: "custom freeform tool", body: () => ({ tools: [{ type: "custom", name: "probe_exec", description: "run" }], input: [ask(SHORT)] }) },
  },
  {
    id: "T_STREAM_OPTIONS_NONSTREAM_001",
    feature: "responses.stream_options.on_nonstreamed_body",
    reliability: "S", tier: "smoke", spec: "unspecified",
    expected: "rejected",   // 実測 2026-09-11。finalizeOutboundBody が除去して対処済み
    observe: acceptance,
    a: { label: "stream=true + stream_options", body: () => ({ stream: true, stream_options: { include_usage: true }, input: [ask(SHORT)] }) },
    b: { label: "stream=false + stream_options", body: () => ({ stream: false, stream_options: { include_usage: true }, input: [ask(SHORT)] }) },
  },
  {
    id: "T_HISTORY_EMPTY_ARGS_001",
    feature: "responses.history.function_call.arguments.empty_string",
    reliability: "S", tier: "smoke", spec: "unspecified",
    expected: "rejected",   // 実測 2026-09-11。finalizeOutboundBody が "{}" へ正規化して対処済み
    observe: acceptance,
    a: { label: 'arguments "{}"', body: () => ({ tools: [TOOL], input: [ask("一覧を。"), call("{}"), result(), ask(SHORT)] }) },
    b: { label: 'arguments ""', body: () => ({ tools: [TOOL], input: [ask("一覧を。"), call(""), result(), ask(SHORT)] }) },
  },
  {
    id: "T_HISTORY_BLANK_ARGS_001",
    feature: "responses.history.function_call.arguments.whitespace_only",
    reliability: "S", tier: "smoke", spec: "unspecified",
    expected: "rejected",   // 実測 2026-09-11。同上
    observe: acceptance,
    a: { label: 'arguments "{}"', body: () => ({ tools: [TOOL], input: [ask("一覧を。"), call("{}"), result(), ask(SHORT)] }) },
    b: { label: 'arguments "   "', body: () => ({ tools: [TOOL], input: [ask("一覧を。"), call("   "), result(), ask(SHORT)] }) },
  },
  {
    id: "T_HISTORY_MALFORMED_ARGS_001",
    feature: "responses.history.function_call.arguments.malformed",
    reliability: "S", tier: "smoke", spec: "unspecified",
    expected: "rejected",   // 意図的に未対処。推測で書き換えるほうが危険という判断
    // Deliberately not repaired by the router: only the empty case is safe to
    // rewrite. This test exists to confirm the endpoint still refuses it, so the
    // decision not to guess stays an informed one.
    observe: acceptance,
    a: { label: 'arguments "{}"', body: () => ({ tools: [TOOL], input: [ask("一覧を。"), call("{}"), result(), ask(SHORT)] }) },
    b: { label: "arguments not JSON", body: () => ({ tools: [TOOL], input: [ask("一覧を。"), call("{not json"), result(), ask(SHORT)] }) },
  },
  {
    id: "T_HISTORY_OPAQUE_001",
    feature: "responses.history.reasoning.encrypted_content",
    reliability: "S", tier: "smoke", spec: "unspecified",
    observe: acceptance,
    a: { label: "plain assistant message", body: () => ({ input: [ask("覚えて。"), said("覚えました。"), ask(SHORT)] }) },
    b: {
      label: "reasoning item with encrypted_content",
      body: () => ({ input: [ask("覚えて。"),
        { id: "rs_probe", type: "reasoning", encrypted_content: "opaque-probe-token", summary: [{ type: "summary_text", text: "検討した。" }] },
        ask(SHORT)] }),
    },
  },
  {
    id: "T_SEARCH_HISTORY_001",
    feature: "responses.history.web_search_call.replay",
    reliability: "S", tier: "smoke", spec: "unspecified",
    observe: acceptance,
    a: { label: "no search in history", body: () => ({ input: [ask("調べて。"), said("調べました。"), ask(SHORT)] }) },
    b: {
      label: "completed web_search_call in history",
      body: () => ({ input: [ask("調べて。"),
        { type: "web_search_call", id: "ws_probe", status: "completed", action: { type: "search", query: "probe" } },
        said("調べました。"), ask(SHORT)] }),
    },
  },

  // ── 8-2 silent ignore 専用 ────────────────────────────────────
  // Each of these pairs a parameter with a task whose output changes when the
  // parameter takes effect. Without that, a 200 proves only that the body was
  // not rejected.
  {
    id: "T_SEARCH_EXEC_001",
    feature: "responses.tools.web_search.executes",
    reliability: "S", tier: "smoke", spec: "unspecified",
    observe: presence("output carries a web_search_call item",
      (parsed) => parsed.items.some((item) => item?.type === "web_search_call")),
    a: { label: "no web_search tool", body: () => ({ max_output_tokens: 2048, input: [ask("Use web_search to find the current Node.js LTS version. Reply with the number only.")] }) },
    b: { label: "web_search tool offered", body: () => ({ max_output_tokens: 2048, tools: [{ type: "web_search" }], input: [ask("Use web_search to find the current Node.js LTS version. Reply with the number only.")] }) },
  },
  {
    id: "T_IGNORE_STREAM_USAGE_001",
    feature: "responses.stream_options.include_usage.honored",
    reliability: "S", tier: "smoke", spec: "unspecified",
    observe: presence("a terminal event carries usage",
      (parsed) => Boolean(parsed.completed?.usage)),
    // Measured 2026-09-12: this endpoint reports usage with or without the
    // parameter, which is `accepted_unconditional` and harmless. The production
    // log shows out_tokens on every Free turn, so the earlier "silently
    // ignored" reading was the probe's mistake, not the endpoint's.
    expected: "accepted_unconditional",
    a: { label: "no stream_options", body: () => ({ stream: true, input: [ask(SHORT)] }) },
    b: { label: "stream_options include_usage", body: () => ({ stream: true, stream_options: { include_usage: true }, input: [ask(SHORT)] }) },
  },
  {
    id: "T_IGNORE_MAX_OUTPUT_001",
    feature: "responses.max_output_tokens.honored",
    reliability: "S", tier: "smoke", spec: "unspecified",
    observe: difference("the capped variant stops earlier than the uncapped control",
      (a, b) => b.completed?.status === "incomplete"
        || (a.text.length > 0 && b.text.length < a.text.length / 2)),
    a: { label: "no cap", body: () => ({ max_output_tokens: null, input: [ask("日本の四季について200文字以上で説明してください。")] }) },
    b: { label: "max_output_tokens 16", body: () => ({ max_output_tokens: 16, input: [ask("日本の四季について200文字以上で説明してください。")] }) },
  },
  {
    id: "T_IGNORE_JSON_SCHEMA_001",
    feature: "responses.text.format.json_schema.honored",
    reliability: "S", tier: "full", spec: "unspecified",
    observe: effect("output parses as the requested object", (parsed) => {
      try {
        const value = JSON.parse(parsed.text.trim());
        return value && typeof value === "object" && typeof value.answer === "string";
      } catch { return false; }
    }),
    a: { label: "no format", body: () => ({ input: [ask("東京の都道府県名を答えてください。")] }) },
    b: {
      label: "json_schema format",
      body: () => ({
        text: { format: { type: "json_schema", name: "probe_answer", strict: true,
          schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } } },
        input: [ask("東京の都道府県名を答えてください。")],
      }),
    },
  },
  {
    id: "T_IGNORE_PARALLEL_TOOLS_001",
    feature: "responses.parallel_tool_calls.false.honored",
    reliability: "A", tier: "full", spec: "unspecified",
    observe: effect("at most one function_call in the turn",
      (parsed) => parsed.items.filter((item) => item?.type === "function_call").length <= 1),
    a: { label: "parallel allowed", body: () => ({ tools: [TOOL], parallel_tool_calls: true, input: [ask("probe_list_sites を2回呼んでください。")] }) },
    b: { label: "parallel disabled", body: () => ({ tools: [TOOL], parallel_tool_calls: false, input: [ask("probe_list_sites を2回呼んでください。")] }) },
  },
];

// Sequence tests capture what the model itself produced and replay it. Synthetic
// history is how the 2026-09-10 reproductions all passed while production kept
// failing: hand-built input silently omitted the one field that mattered.
export const SEQUENCES = [
  {
    id: "T_SEQ_REPLAY_OWN_TOOL_CALL_001",
    feature: "responses.history.replay.model_generated_tool_call",
    reliability: "S", tier: "full", spec: "unspecified",
    elicit: () => ({ tools: [TOOL], tool_choice: "auto", input: [ask("probe_list_sites を呼んでサイト一覧を取得してください。")] }),
    // Variants applied to the captured function_call before replay.
    variants: [
      { label: "verbatim", mutate: (item) => item },
      { label: "arguments emptied", mutate: (item) => ({ ...item, arguments: "" }) },
      { label: "id removed", mutate: ({ id, ...rest }) => rest },
      { label: "status removed", mutate: ({ status, ...rest }) => rest },
    ],
    replay: (item, tool) => ({ tools: [tool], input: [ask("一覧を。"), item, result(item.call_id ?? "probe_c1"), ask(SHORT)] }),
    tool: TOOL,
  },
];

export function selectTests({ tier = "smoke", only } = {}) {
  const order = { smoke: 0, full: 1, limits: 2 };
  return TESTS.filter((test) => {
    if (only?.length) return only.includes(test.id);
    return order[test.tier ?? "full"] <= order[tier];
  });
}
