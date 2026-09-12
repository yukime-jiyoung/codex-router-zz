import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { isMuseFree, museFreeHeaders, museFreePreflight, museFreeSessionId, MUSE_FREE_ID } from "../src/muse-free.mjs";
import { museFreeOutputMarker, museFreePortableInput } from "../src/muse-free.mjs";
import { createResponsesStreamTransform, createResponsesJsonTransform } from "../src/openai-adapters.mjs";

test("Free reasoning origin survives streams; portable history preserves visible content and tool pairs", async () => {
  const reasoning={id:"rs_test",type:"reasoning",encrypted_content:"opaque",summary:[{type:"summary_text",text:"visible summary"}]};
  const output=[reasoning,{id:"msg_test",type:"message",role:"assistant",content:[{type:"output_text",text:"visible answer"}]}];
  const response={id:"resp_test",object:"response",status:"completed",output};
  for(const stream of [false,true]) {
    const transform=stream?createResponsesStreamTransform(new Map(),museFreeOutputMarker()):createResponsesJsonTransform(new Map(),museFreeOutputMarker());
    const body=stream?`event: response.completed\ndata: ${JSON.stringify({type:"response.completed",response})}\n\n`:JSON.stringify(response);
    let text="";transform.on("data",c=>text+=c);
    const done=new Promise((resolve,reject)=>{transform.on("end",resolve);transform.on("error",reject)});
    for(const byte of Buffer.from(body))transform.write(Buffer.from([byte]));transform.end();await done;
    const parsed=JSON.parse(stream?text.split("\n").find(l=>l.startsWith("data: ")).slice(6):text);
    const items=stream?parsed.response.output:parsed.output;
    assert.match(items[0].id,/^rs_musefree_/);assert.equal(items[0].encrypted_content,"opaque");
    const native=museFreePortableInput(items,{native:true});assert.equal(native[0].content[0].text,"visible summary");assert.deepEqual(native[1],output[1]);
  }
  assert.equal(museFreePortableInput([reasoning],{native:true})[0],reasoning,"ordinary GPT reasoning unchanged");
  const pair=[{type:"function_call",call_id:"pair",name:"exec_command",arguments:"{}"},{type:"function_call_output",call_id:"pair",output:"result"}];
  const payload={input:[reasoning,...pair]};museFreePreflight(payload,{"thread-id":"11111111-2222-3333-4444-555555555555"});
  assert.equal(payload.input[0].content[0].text,"visible summary");assert.deepEqual(payload.input.slice(1),pair);assert.equal(reasoning.encrypted_content,"opaque");
  assert.throws(()=>museFreePortableInput([{...reasoning,summary:[{type:"unknown",text:"keep"}]}]),/unsupported summary/);
  assert.throws(()=>museFreePortableInput([{...reasoning,content:[{type:"text",text:"do not lose"}]}]),/unsupported summary/);
  for(const content of [null,[]])assert.equal(museFreePortableInput([{...reasoning,content}])[0].content[0].text,"visible summary");
  const desktop = {...reasoning, content:null, internal_chat_message_metadata_passthrough:{turn_id:"01a07fea-fea9-7b50-9dcf-123bbc17182e"}};
  assert.equal(museFreePortableInput([desktop])[0].content[0].text,"visible summary");
  assert.ok(desktop.internal_chat_message_metadata_passthrough,"stored history is unchanged");
  assert.throws(()=>museFreePortableInput([{...reasoning,unknown_field:"keep"}]),/unsupported summary/);
  const marker=museFreeOutputMarker();const added={item:{id:"rs_message",type:"message",content:[{type:"output_text",text:"keep"}]}};
  marker(added);assert.match(added.item.id,/^msg_musefree_/);assert.equal(added.item.content[0].text,"keep");
  const delta={item_id:"rs_message"};marker(delta);assert.equal(delta.item_id,added.item.id);
});

const thread = "11111111-2222-3333-4444-555555555555";
const free = {
  provider: "opencode-zen-responses", upstreamModel: MUSE_FREE_ID,
  slug: `opencode-zen-responses/${MUSE_FREE_ID}`,
  gatewayModel: "opencode-zen-responses-muse-spark-1-3-contributor-free",
  displayName: "Muse Spark 1.3 Contributor Free (OpenCode Zen)",
  description: "Phase A candidate; live tool compatibility unverified. Prompts and completions may be used for Meta training.",
  listed: true, priority: 48, contextWindow: 1048576, autoCompact: 891289,
  defaultEffort: "high", reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"].map(effort => ({ effort, description: effort })),
  inputModalities: ["text", "image"], isFree: true,
  compHash: "muse-free-phase-a-v1",
  // Measured 2026-09-10 against POST https://opencode.ai/zen/v1/responses for
  // this exact model, so the fixture route carries what production ships.
  toolStrictMode: "drop", requestProfile: "auto-tool-choice",
};

test("exact route and strict thread identity; no credential/header leakage", () => {
  assert.equal(isMuseFree(free), true);
  assert.equal(isMuseFree({ ...free, upstreamModel: "muse-spark-1.3" }), false);
  assert.equal(isMuseFree({ ...free, provider: "opencode-go" }), false);
  assert.throws(() => museFreeHeaders({ "session-id": thread }, "fixture-key", "0.5.1"), /thread-id/);
  assert.throws(() => museFreeHeaders({ "thread-id": `prefix-${thread}` }, "fixture-key", "0.5.1"), /thread-id/);
  const h = museFreeHeaders({ "thread-id": thread, cookie: "PRIVATE", authorization: "OPENAI", "x-api-key": "PRIVATE" }, "fixture-key", "0.5.1");
  assert.equal(h["x-opencode-session"], thread);
  assert.equal(h.Authorization, "Bearer fixture-key");
  assert.equal(h["User-Agent"], "codex-router/0.5.1");
  assert.doesNotMatch(JSON.stringify(h), /PRIVATE|OPENAI/);
  for (const payload of [{previous_response_id:"another-provider"},{input:[{encrypted_content:"opaque"}]},{input:[{type:"item_reference",id:"other"}]}]) {
    assert.throws(()=>museFreePreflight(payload,{"thread-id":thread}),e=>e.code==="muse_free_nonportable_history");
  }
});

test("real router + real API forwarder, loopback upstream: model switches, tool wire roundtrip and failures", { timeout: 180000 }, async () => {
  const root = path.resolve(process.env.MUSE_TEST_ROOT);
  assert.ok(root.includes("work"));
  const state = path.join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "user-models.json"), JSON.stringify({ version: 1, models: [free] }));
  writeFileSync(path.join(state, "failover.json"), JSON.stringify({ version: 1, enabled: true, chain: ["zai-api/glm-5.2"] }));
  writeFileSync(path.join(state, "opencode-go-api-key.secret"), "fixture-key");
  writeFileSync(path.join(state, "zai-api-key.secret"), "fixture-fallback-key");
  const seen = [];
  let failure = 0; let invalidSummary=false;
  const servers = [], children = []; let childStderr = "";
  async function server(handler) {
    const s = http.createServer(handler); servers.push(s);
    await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${s.address().port}`;
  }
  const upstream = await server(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url === "/health") { res.end("{}"); return; }
    seen.push({ body, headers: req.headers, url: req.url });
    if (body.model === MUSE_FREE_ID && typeof failure === "string") {
      res.writeHead(200,{"content-type":"text/event-stream"});
      res.end(`event: response.${failure}\ndata: ${JSON.stringify({type:`response.${failure}`,response:{id:"resp_fixture",status:failure,error:{message:"fixture stream failure"},output:[]}})}\n\n`); return;
    }
    if (body.model === MUSE_FREE_ID && failure) {
      res.writeHead(failure, { "content-type": "application/json", "retry-after": "137" });
      res.end(JSON.stringify({ error: { message: "fixture refusal", type: "FreeUsageLimitError" } })); return;
    }
    const result = body.input?.some?.(item => item.type === "function_call_output");
    const output = body.model === MUSE_FREE_ID && !result && body.stream !== false
      ? [{ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "write_fixture", arguments: '{"text":"fixture"}', status: "completed" }]
      : [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: invalidSummary ? "invalid summary" : (body.stream === false || JSON.stringify(body.input).includes("ROUTER SOURCE CATALOG")) ? JSON.stringify({objective:"Preserve COMPACT_CONTEXT_731",requirement_refs:["U001"],attempt_refs:[],observation_refs:[],unverified:[],unknowns:[],blockers:[],next_step:"continue"}) : "fixture complete", annotations: [] }] }];
    const response = { id: "resp_fixture", object: "response", status: "completed", output, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } };
    if(body.stream === false) {res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(response));return;}
    if(body.model.startsWith("gpt") && JSON.stringify(body.input).includes("ROUTER SOURCE CATALOG")) {
      res.writeHead(200,{"content-type":"text/event-stream"});
      res.end(`event: response.output_item.done\ndata: ${JSON.stringify({type:"response.output_item.done",output_index:0,item:output[0]})}\n\nevent: response.completed\ndata: ${JSON.stringify({type:"response.completed",response:{...response,output:[]}})}\n\n`);return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
  });
  async function port() { const s=http.createServer(); await new Promise(r=>s.listen(0,"127.0.0.1",r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
  const apiPort=await port(), routerPort=await port();
  const env = { ...process.env, CODEX_HOME: path.join(root,"codex"), MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_INTERNAL_KEY: "fixture-internal-key-long-enough-123456", CODEX_ROUTER_INTERNAL_KEY: "fixture-internal-key-long-enough-123456",
    CODEX_ROUTER_CALLER_KEY: "fixture-caller-key-long-enough-123456", MODEL_ROUTER_API_PORT: String(apiPort),
    CODEX_ROUTER_PORT: String(routerPort), CODEX_ROUTER_API_BASE_URL: `http://127.0.0.1:${apiPort}/v1`,
    CODEX_ROUTER_GATEWAY_BASE_URL: upstream+"/v1", CODEX_NATIVE_BASE_URL: upstream+"/v1",
    OPENCODE_ZEN_BASE_URL: upstream+"/v1", OPENCODE_API_KEY: "fixture-key", ZAI_PLATFORM_API_KEY: "fixture-fallback-key",
    CODEX_ROUTER_SHOW_ALL_MODELS: "1", MODEL_ROUTER_SKIP_SERVICE_MANAGER: "1",
    CODEX_ROUTER_OAUTH_HEALTH_URL: upstream+"/health", CODEX_ROUTER_API_HEALTH_URL: upstream+"/health",
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: upstream+"/health", CODEX_ROUTER_GATEWAY_HEALTH_URL: upstream+"/health",
  };
  async function launch(file) {
    const child=spawn(process.execPath,[`src/${file}.mjs`],{cwd:process.cwd(),env,stdio:["ignore","ignore","pipe"],windowsHide:true});
    children.push(child); let errors=""; child.stderr.on("data",c=>{errors+=c; childStderr+=c;});
    const base=file==="router"?`http://127.0.0.1:${routerPort}`:`http://127.0.0.1:${apiPort}`;
    for(let n=0;n<600;n++) { if(child.exitCode!==null) throw new Error(errors); try { const r=await fetch(base+"/health",{headers:{Authorization:"Bearer fixture-internal-key-long-enough-123456"}}); if(r.ok)return; }catch{} await new Promise(r=>setTimeout(r,50)); }
    throw new Error("startup timeout: "+errors);
  }
  const { callerBaseUrl } = await import("../src/caller-auth.mjs");
  const base=callerBaseUrl(routerPort,"fixture-caller-key-long-enough-123456");
  async function send(model, input=[{role:"user",content:"use fixture"}], id=thread, extra={}) {
    const response=await fetch(base+"/responses",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer fixture-native-key",...(id?{"thread-id":id}:{}),cookie:"PRIVATE"},body:JSON.stringify({model,input,stream:true,tools:[{type:"function",name:"write_fixture",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"]}}],...extra})});
    return {status:response.status,text:await response.text()};
  }
  try {
    await launch("api-forwarder"); await launch("router");
    for(const model of ["gpt-6-astra",free.slug,"gpt-6-astra",free.slug]) {
      const r=await send(model); assert.equal(r.status,200,r.text); assert.match(r.text,/response.completed/);
    }
    assert.deepEqual(seen.map(x=>x.body.model),["gpt-6-astra",MUSE_FREE_ID,"gpt-6-astra",MUSE_FREE_ID]);
    const toolResult=await send(free.slug,[{type:"function_call",call_id:"call_fixture",name:"write_fixture",arguments:'{"text":"fixture"}'},{type:"function_call_output",call_id:"call_fixture",output:"fixture written"}]);
    assert.equal(toolResult.status,200,toolResult.text); assert.match(toolResult.text,/fixture complete/);
    assert.ok(seen.at(-1).body.input.some(x=>x.call_id==="call_fixture"&&x.output==="fixture written"));
    const compact = await send(free.slug,[{role:"user",content:"Preserve COMPACT_CONTEXT_731"},{type:"compaction_trigger"}]);
    assert.equal(compact.status,200,compact.text);
    const completed=compact.text.split("\n").filter(l=>l.startsWith("data: {")).map(l=>JSON.parse(l.slice(6))).find(e=>e.type==="response.completed");
    assert.equal(completed.response.output[0].type,"compaction");
    for(const destination of [free.slug,"gpt-6-astra"]) {
      const replay=await send(destination,[...completed.response.output,{role:"user",content:"continue"}]);
      assert.equal(replay.status,200,replay.text);
      assert.match(JSON.stringify(seen.at(-1).body.input),/COMPACT_CONTEXT_731/);
      assert.doesNotMatch(JSON.stringify(seen.at(-1).body.input),/encrypted_content/);
    }
    const nativeCompact = await send("gpt-6-astra",[{type:"message",role:"user",content:[{type:"input_text",text:"Preserve COMPACT_CONTEXT_731"}]},{type:"compaction_trigger"}]);
    assert.equal(nativeCompact.status,200,nativeCompact.text);
    const nativeCompleted=nativeCompact.text.split("\n").filter(l=>l.startsWith("data: {")).map(l=>JSON.parse(l.slice(6))).find(e=>e.type==="response.completed");
    assert.equal(nativeCompleted.response.output[0].type,"compaction");
    assert.equal((await send(free.slug,nativeCompleted.response.output)).status,200);
    assert.match(JSON.stringify(seen.at(-1).body.input),/COMPACT_CONTEXT_731/);
    invalidSummary=true;
    for(const destination of [free.slug,"gpt-6-astra"]) {
      const rejected=await send(destination,[{type:"message",role:"user",content:[{type:"input_text",text:"retain me"}]},{type:"compaction_trigger"}]);
      assert.equal(rejected.status,502,rejected.text);assert.doesNotMatch(rejected.text,/"type":"compaction"/);
    }
    invalidSummary=false;
    await send(free.slug,undefined,thread,{tools:[{type:"web_search",search_content_types:["text"],search_context_size:"low"}]});
    assert.equal(seen.at(-1).body.tools[0].search_content_types,undefined);
    assert.equal(seen.at(-1).body.tools[0].search_context_size,"low");
    const other="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await Promise.all([send(free.slug,undefined,other),send("gpt-6-astra")]);
    const freeRequests=seen.filter(x=>x.body.model===MUSE_FREE_ID);
    for(const x of freeRequests) { assert.equal(x.headers.authorization,"Bearer fixture-key"); assert.equal(x.headers.cookie,undefined); assert.match(x.headers["user-agent"],/^codex-router\//); assert.equal(x.url,"/v1/responses"); }
    assert.deepEqual(new Set(freeRequests.map(x=>x.headers["x-opencode-session"])),new Set([thread,other]));
    // The endpoint refuses a function tool carrying strict:true whose `required`
    // omits an optional property (HTTP 400 "Missing 'limit'"), and refuses a named
    // tool_choice ("only `\"auto\"` is supported"). Both repairs travel with this
    // route, so assert the bytes the endpoint actually receives rather than the
    // flags on the model entry.
    const strictProbe={type:"function",name:"probe_optional",strict:true,parameters:{type:"object",properties:{site_id:{type:"string"},limit:{type:"number"}},required:["site_id"]}};
    const repaired=await send(free.slug,undefined,thread,{tools:[strictProbe],tool_choice:{type:"function",name:"probe_optional"}});
    assert.equal(repaired.status,200,repaired.text);
    const repairedBody=seen.filter(x=>x.body.model===MUSE_FREE_ID).at(-1).body;
    assert.equal(repairedBody.tools.some(t=>"strict" in t),false,"strict must not reach this endpoint");
    assert.equal(repairedBody.tool_choice,"auto","a named tool choice must be normalized to auto");
    const count=seen.length; const absent=await send(free.slug,undefined,null); assert.equal(absent.status,400,absent.text); assert.match(absent.text,/muse_free_thread_id_required/); assert.equal(seen.length,count);
    const opaque=await send(free.slug,undefined,thread,{previous_response_id:"other-upstream"}); assert.equal(opaque.status,400,opaque.text); assert.match(opaque.text,/muse_free_nonportable_history/); assert.equal(seen.length,count);
    // A refusal that reaches no endpoint is otherwise invisible: production
    // saw one on its first turn and its cause could not be recovered.
    for (let n=0; n<100 && !/muse_free_nonportable_history/.test(childStderr); n++) await new Promise(r=>setTimeout(r,20));
    const refusals=childStderr.split(/\r?\n/).filter(line=>line.includes('"refused":"muse-free"')).map(line=>JSON.parse(line));
    assert.deepEqual(new Set(refusals.map(r=>r.code)),new Set(["muse_free_thread_id_required","muse_free_nonportable_history"]),childStderr);
    assert.equal(refusals.find(r=>r.code==="muse_free_nonportable_history").reason,"previous_response_id");
    assert.doesNotMatch(childStderr,/use fixture|fixture written|PRIVATE|fixture-key/,"a refusal line must carry no conversation text, header value or credential");
    // A compaction body is never streamed, so `stream_options` carried over
    // from the caller is a contradiction OpenCode Zen refuses outright. It
    // broke every compaction on that route while the turn itself worked.
    const compacted=await send(free.slug,undefined,thread,{
      stream_options:{include_usage:true},
      input:[{type:"message",role:"user",content:[{type:"input_text",text:"keep"}]},{type:"compaction_trigger"}],
    });
    assert.equal(compacted.status,200,compacted.text);
    const compactionBody=seen.at(-1)?.body;
    assert.equal(compactionBody?.stream,false,"the compaction body is not streamed");
    assert.equal("stream_options" in (compactionBody||{}),false,"stream_options must not survive onto a non-streamed body");
    // Codex writes `arguments: ""` for a tool that takes none. Zen refuses it
    // and the item is replayed forever, so one such call would end the thread.
    const emptyArgs=await send(free.slug,undefined,thread,{input:[
      {type:"message",role:"user",content:[{type:"input_text",text:"go"}]},
      {type:"function_call",call_id:"call_e1",name:"list_sites",arguments:""},
      {type:"function_call_output",call_id:"call_e1",output:"[]"},
      {type:"function_call",call_id:"call_e2",name:"list_sites",arguments:"   "},
      {type:"function_call_output",call_id:"call_e2",output:"[]"},
      {type:"function_call",call_id:"call_e3",name:"echo",arguments:"{\"a\":1}"},
      {type:"function_call_output",call_id:"call_e3",output:"ok"},
    ]});
    assert.equal(emptyArgs.status,200,emptyArgs.text);
    const sentArgs=(seen.at(-1)?.body?.input||[]).filter(i=>i?.type==="function_call").map(i=>i.arguments);
    assert.deepEqual(sentArgs,["{}","{}","{\"a\":1}"],"empty arguments become {} and real arguments are untouched");
    // The compaction builds its own body, so repairing only the routed turn
    // left exactly this path failing. Both must be covered.
    const emptyArgsCompaction=await send(free.slug,undefined,thread,{input:[
      {type:"message",role:"user",content:[{type:"input_text",text:"go"}]},
      {type:"function_call",call_id:"call_c1",name:"list_sites",arguments:""},
      {type:"function_call_output",call_id:"call_c1",output:"[]"},
      {type:"compaction_trigger"},
    ]});
    assert.equal(emptyArgsCompaction.status,200,emptyArgsCompaction.text);
    const compactionArgs=(seen.at(-1)?.body?.input||[]).filter(i=>i?.type==="function_call").map(i=>i.arguments);
    assert.ok(compactionArgs.every(a=>{try{JSON.parse(a);return true}catch{return false}}),
      "every function_call reaching the endpoint carries parseable arguments: "+JSON.stringify(compactionArgs));
    // Both invariants, asserted on the bytes that actually left, for both
    // body builders. Repairing one path and not the other is how each of
    // these reached production twice; this is the regression that catches it.
    for (const [label, extra] of [
      ["routed turn", {input:[
        {type:"message",role:"user",content:[{type:"input_text",text:"go"}]},
        {type:"function_call",call_id:"call_b1",name:"list_sites",arguments:""},
        {type:"function_call_output",call_id:"call_b1",output:"[]"},
      ]}],
      ["compaction", {stream_options:{include_usage:true}, input:[
        {type:"message",role:"user",content:[{type:"input_text",text:"go"}]},
        {type:"function_call",call_id:"call_b2",name:"list_sites",arguments:"   "},
        {type:"function_call_output",call_id:"call_b2",output:"[]"},
        {type:"compaction_trigger"},
      ]}],
    ]) {
      const sent = await send(free.slug, undefined, thread, extra);
      assert.equal(sent.status, 200, label + ": " + sent.text);
      const body = seen.at(-1)?.body || {};
      if (body.stream !== true) {
        assert.equal("stream_options" in body, false,
          label + ": stream_options must not ride on a body that is not streamed");
      }
      for (const item of (body.input || [])) {
        if (item?.type !== "function_call" || typeof item.arguments !== "string") continue;
        assert.doesNotThrow(() => JSON.parse(item.arguments),
          label + ": every function_call must carry parseable arguments, got " + JSON.stringify(item.arguments));
      }
    }

    // An upstream refusal must leave a trace naming the stage and the status.
    // Without it a relayed 400 is invisible on this side, which is exactly
    // what made the 2026-09-10 compaction failures unexplainable.
    failure = 400;
    const refused = await send(free.slug);
    assert.equal(refused.status, 400, refused.text);
    failure = undefined;
    for (let n = 0; n < 100 && !/upstreamRejected/.test(childStderr); n++) await new Promise(r => setTimeout(r, 20));
    const rejections = childStderr.split(/\r?\n/)
      .filter(line => line.includes('"upstreamRejected"'))
      .map(line => JSON.parse(line));
    assert.ok(rejections.length, "an upstream refusal must be logged: " + childStderr);
    const rejection = rejections.at(-1);
    assert.equal(rejection.status, 400);
    assert.equal(rejection.model, free.slug);
    assert.ok(["routed-turn", "compaction"].includes(rejection.upstreamRejected), rejection.upstreamRejected);
    assert.ok(typeof rejection.excerpt === "string" && rejection.excerpt.length <= 400,
      "the excerpt must be bounded");
    assert.doesNotMatch(childStderr, /fixture-key|PRIVATE/,
      "a rejection line must carry no credential");
    for(const status of [401,402,403,429]) { failure=status; const n=seen.length; const r=await send(free.slug); assert.equal(r.status,status,r.text); assert.equal(seen.length,n+1,"must not fallback"); assert.equal((await send("gpt-6-astra")).status,200); }
    for(const status of ["failed","incomplete"]) { failure=status; const r=await send(free.slug); assert.doesNotMatch(r.text,/response.completed/); assert.match(r.text,/failed|incomplete|error/); assert.equal((await send("gpt-6-astra")).status,200); }
    failure=0;
    writeFileSync(path.join(root,"observations.json"),JSON.stringify({requests:seen.map(x=>({model:x.body.model,url:x.url,session:x.headers["x-opencode-session"]?"fixture-thread":"native",authorization:"redacted"})),pids:children.map(c=>c.pid),actualCodexToolExecution:false,desktopPicker:false},null,2));
  } finally {
    for(const child of children) { if(child.exitCode===null){child.kill(); await new Promise(r=>child.once("exit",r));} }
    for(const s of servers){s.closeAllConnections(); await new Promise(r=>s.close(r));}
  }
});

test("a refused Free turn names which guard produced it, and leaks nothing", () => {
  const lines=[]; const real=process.stderr.write;
  process.stderr.write=(chunk)=>{lines.push(String(chunk));return true};
  const secretText="TOP_SECRET_CONVERSATION_TEXT";
  try {
    // thread-id is absent but Codex sent an id under a name `threadIdFromHeaders`
    // accepts and this route deliberately does not. The line must say so.
    assert.throws(()=>museFreeSessionId({"session-id":"01a08b9a-d6cf-7b90-a3c4-2651d89ae4af","x-codex-window-id":"w"}),
      err=>err.code==="muse_free_thread_id_required");
    let entry=JSON.parse(lines.at(-1));
    assert.equal(entry.refused,"muse-free");
    assert.equal(entry.code,"muse_free_thread_id_required");
    assert.equal(entry.threadHeader,"absent");
    assert.deepEqual(entry.otherIdHeadersPresent,["session-id","x-codex-window-id"]);
    // A malformed thread-id is reported as unusable rather than absent.
    assert.throws(()=>museFreeSessionId({"thread-id":"not-a-uuid"}),err=>err.code==="muse_free_thread_id_required");
    assert.equal(JSON.parse(lines.at(-1)).threadHeader,"unusable");
    // An opaque reference is reported with the path it sat at.
    assert.throws(()=>museFreePreflight({input:[{type:"message",role:"user",content:[{type:"input_text",text:secretText}]},{type:"item_reference",id:"ir_1"}]},{"thread-id":thread}),
      err=>err.code==="muse_free_nonportable_history");
    entry=JSON.parse(lines.at(-1));
    assert.equal(entry.reason,"item_reference");
    assert.equal(entry.itemType,"item_reference");
    assert.match(entry.at,/^input[.]1$/);
    // An unsupported reasoning shape names the unexpected keys, not their values.
    assert.throws(()=>museFreePortableInput([{id:"rs_musefree_x",type:"reasoning",summary:[{type:"summary_text",text:secretText}],unknown_field:secretText}]),
      err=>err.code==="muse_free_nonportable_history");
    entry=JSON.parse(lines.at(-1));
    assert.equal(entry.reason,"reasoning_summary_shape");
    assert.deepEqual(entry.unexpectedKeys,["unknown_field"]);
    assert.equal(entry.marked,true);
    // Nothing the caller sent may appear in any line.
    assert.equal(lines.join("").includes(secretText),false,"a refusal line must never carry conversation text");
  } finally { process.stderr.write=real; }
});
