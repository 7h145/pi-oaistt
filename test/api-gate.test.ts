/** Synthetic native-Pi feasibility gate. Author: thias, OpenAI Codex (gpt-6.1-sol). MIT. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore, getSupportedThinkingLevels,
  type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createPiUI } from "./pi-ui-fixture.ts";

test("public supported thinking distinguishes off, reasoning, null maps and opt-in extended levels", async () => {
  const faux = fauxProvider({ models: [{ id: "reasoning", reasoning: true }, { id: "plain" }] });
  const model = faux.getModel("reasoning")!;
  assert.ok(getSupportedThinkingLevels(model).includes("off"));
  assert.ok(getSupportedThinkingLevels(model).includes("low"));
  assert.deepEqual(getSupportedThinkingLevels(faux.getModel("plain")!), ["off"]);
  model.thinkingLevelMap = { low: null, max: "custom-budget" };
  assert.ok(!getSupportedThinkingLevels(model).includes("low"));
  assert.ok(getSupportedThinkingLevels(model).includes("max"));
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime); registry.registerProvider(faux.provider);
  const payloads: (SimpleStreamOptions | undefined)[] = [];
  faux.setResponses([(...args) => { payloads.push(args[1]); return fauxAssistantMessage("fixture"); },
    (...args) => { payloads.push(args[1]); return fauxAssistantMessage("fixture"); }]);
  await registry.streamSimple(model, { messages: [] }, {}).result();
  await registry.streamSimple(model, { messages: [] }, { reasoning: undefined }).result();
  assert.equal(payloads[0]?.reasoning, undefined); assert.equal(payloads[1]?.reasoning, undefined);
});

test("native shortcut dispatcher freezes map until full setup; disabled map after native reset loses old handlers", () => {
  const h = createPiUI();
  Object.assign(h.session, { agent: { signal: new AbortController().signal } });
  try {
    let f8 = 0, f7 = 0;
    let keys = new Map([["f8", { handler: () => { f8++; } }]]);
    const runner = { getModelRegistry: () => ({}), getShortcuts: () => keys };
    h.mode.setupExtensionShortcuts(runner);
    h.terminal.send("\x1b[19~"); assert.equal(f8, 1);
    keys = new Map([["f7", { handler: () => { f7++; } }]]);
    h.terminal.send("\x1b[18~"); assert.equal(f7, 0);
    h.mode.setupExtensionShortcuts(runner);
    h.terminal.send("\x1b[18~"); assert.equal(f7, 1);
    // resetExtensionUI clears this public callback during real /reload; the
    // fixture lacks unrelated overlay/title state, so isolate that assignment.
    h.mode.defaultEditor.onExtensionShortcut = undefined;
    keys = new Map(); h.mode.setupExtensionShortcuts(runner);
    h.terminal.send("\x1b[19~"); h.terminal.send("\x1b[18~");
    assert.equal(f8, 1); assert.equal(f7, 1);
    const dialog = h.showDialog(); dialog.setValue("");
    h.terminal.send("\x1b[19~"); assert.equal(f8, 1);
  } finally { h.stop(); }
});

test("native compatible adapter payload uses mapped low and its normal omitted/off behavior", async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  registry.registerProvider("synthetic-payload", { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
    apiKey: "synthetic-only", models: [{ id: "one", name: "fixture", reasoning: true, input: ["text"],
      contextWindow: 8192, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: { low: "custom-low" }, compat: { thinkingFormat: "openai" } }] });
  const model = registry.find("synthetic-payload", "one")!;
  const payloads: Record<string, unknown>[] = [];
  for (const reasoning of [undefined, "low"] as const) {
    await registry.streamSimple(model, { messages: [{ role: "user", content: "synthetic target", timestamp: 0 }] }, {
      reasoning,
      fetch: async () => { throw new Error("Synthetic network disabled"); },
      onPayload: payload => { payloads.push(payload as Record<string, unknown>); throw new Error("Synthetic payload gate"); },
    }).result();
  }
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0]!.reasoning_effort, undefined);
  assert.equal(payloads[1]!.reasoning_effort, "custom-low");
});
