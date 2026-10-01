/**
 * pi-oaistt extension tests
 *
 * Purpose: verify extension behavior without real audio, credentials or provider calls.
 * Strategy: combine synthetic inputs and controlled failures with relevant real APIs.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.1.0
 * Date: 2026-10-01
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext,
  type ModelRegistry, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { ConfigStore, parseConfig, type Config } from "../src/config.ts";
import { registerDictation, STATUS_KEY, WIDGET_KEY } from "../src/extension.ts";
import { createPiUI } from "./pi-ui-fixture.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of open.splice(0)) await dispose(); });

function harness(options: { mode?: ExtensionContext["mode"]; streaming?: boolean; compacting?: boolean; fullscreen?: boolean } = {}) {
  const native = createPiUI({ streaming: options.streaming, compacting: options.compacting,
    mode: options.fullscreen ? "fullscreen" : "regular" });
  const notices: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[] | undefined>();
  const ui = { ...native.ui,
    notify: (text: string) => notices.push(text.replace(/\x1b\[[0-9;]*m/g, "")),
    setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); },
    setWidget: (key: string, value: unknown) => {
      assert.ok(value === undefined || Array.isArray(value)); widgets.set(key, value as string[] | undefined);
    },
  };
  const events = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
  let shortcut!: { handler(ctx: ExtensionContext): void | Promise<void> };
  let config = parseConfig({ transcription: { apiKeyEnv: null }, correction: { enabled: false } });
  const ready = deferred<void>(); ready.resolve();
  const raw = deferred<string>();
  const edited = deferred<{ text: string; rawFallback: boolean }>();
  let cleanup: Promise<void> = Promise.resolve();
  const main = new AbortController();
  const signals: AbortSignal[] = [];
  const settings: Config[] = [];
  let captures = 0, disposals = 0, stops = 0, loads = 0;
  let clock = 0;
  const session = SessionManager.inMemory("/synthetic");
  const ctx = {
    mode: options.mode ?? "tui", hasUI: options.mode !== "json" && options.mode !== "print", cwd: "/synthetic", ui,
    sessionManager: session, modelRegistry: { find: () => undefined } as unknown as ModelRegistry,
    isIdle: native.isIdle, isProjectTrusted: () => true, signal: main.signal,
    abort: () => { throw new Error("must not abort main agent"); },
    hasPendingMessages: () => false, shutdown: () => { throw new Error("must not shut down Pi"); },
    getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => { throw new Error("must not read main prompt"); },
    scopedModels: [], model: undefined,
  } as ExtensionContext;
  Object.defineProperty(ctx, "model", { get: () => { throw new Error("must not use selected model"); } });
  const pi = {
    getCommands: native.pi.getCommands,
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      events.set(event, [...events.get(event) ?? [], handler]); return () => {};
    },
    registerCommand: (name: string, value: typeof command) => { assert.equal(name, "oaistt"); command = value; },
    registerShortcut: (key: string, value: typeof shortcut) => { assert.equal(key, "f8"); shortcut = value; },
  } as unknown as ExtensionAPI;
  const result = registerDictation(pi, {
    store: { load: async () => { loads++; return config; }, setSource: (source) => { config = structuredClone(config); config.recorder.source = source; }, saveSource: async () => {} },
    key: () => undefined, clock: () => clock,
    record: (config, signal) => { captures++; signals.push(signal); settings.push(config);
      return { ready: ready.promise, stop: async () => { stops++; return { path: "/synthetic.wav", bytes: 100 }; },
        dispose: () => { disposals++; return cleanup; } };
    },
    transcribe: async (_audio, config, signal) => { signals.push(signal); settings.push(config); return raw.promise; },
    correct: async (_raw, config, signal) => { signals.push(signal); settings.push(config); return edited.promise; },
  });
  const emit = async (event: string, data: object = {}) => {
    for (const handler of events.get(event) ?? []) await handler({ type: event, ...data }, ctx);
  };
  // Exercise the REAL native extension-shortcut dispatcher and CustomEditor
  // forwarding, rather than equating a direct handler call with delivered F8.
  native.mode.createExtensionUIContext = () => ui;
  Object.assign(native.session, { sessionManager: session, settingsManager: { isProjectTrusted: () => true },
    scopedModels: [], agent: { signal: main.signal }, pendingMessageCount: 0,
    getContextUsage: () => undefined, systemPrompt: "synthetic main prompt" });
  Object.defineProperty(native.session, "isIdle", { get: native.isIdle });
  native.mode.setupExtensionShortcuts({ getModelRegistry: () => ctx.modelRegistry, getShortcuts: () => new Map([["f8", {
    handler: (context: unknown) => shortcut.handler(context as ExtensionContext),
  }]]) });
  native.mode.defaultEditor.onEscape = () => main.abort();
  open.push(async () => { await emit("session_shutdown", { reason: "quit" }); native.stop(); });
  return { ...native, ctx, ui, notices, statuses, widgets, config, signals, settings, ready, raw, edited, main, emit,
    controller: result.controller,
    start: () => emit("session_start", { reason: "startup" }),
    command: (args: string) => command.handler(args, ctx as ExtensionCommandContext),
    f8: () => native.terminal.send("\x1b[19~"),
    counts: () => ({ captures, disposals, stops, loads }),
    setConfig: (next: Config) => { config = next; },
    holdCleanup: (next: Promise<void>) => { cleanup = next; },
    setClock: (next: number) => { clock = next; },
  };
}

for (const fullscreen of [false, true]) for (const busy of ["idle", "streaming", "compacting"] as const) {
  test(`native F8 ${fullscreen ? "fullscreen" : "regular"}/${busy}: capture, stop, latest draft append, no main action`, async () => {
    const h = harness({ fullscreen, streaming: busy === "streaming", compacting: busy === "compacting" });
    assert.equal(h.counts().loads, 0); assert.equal(h.counts().captures, 0);
    await h.start(); h.f8(); await nextTask();
    assert.equal(h.controller.phase, "recording");
    assert.match(h.statuses.get(STATUS_KEY)!, /REC 00:00/); assert.ok(h.widgets.get(WIDGET_KEY));
    h.ui.setEditorText("typing continues\n"); h.f8(); await nextTask();
    assert.equal(h.controller.phase, "transcribing"); assert.equal(h.counts().captures, 1);
    h.raw.resolve("synthetic dictation"); await h.controller.settled(); await nextTask();
    assert.equal(h.ui.getEditorText(), "typing continues\nsynthetic dictation");
    assert.equal(h.promptCalls.length, 0); assert.equal(h.main.signal.aborted, false);
    assert.equal(h.statuses.get(STATUS_KEY), undefined); assert.equal(h.widgets.get(WIDGET_KEY), undefined);
  });
}

for (const busy of ["idle", "streaming", "compacting"] as const) for (const key of ["\r", "\x1b\r"]) {
  test(`${busy} native submit/follow-up before STT finishes synchronously cancels integrated operation`, async () => {
    const h = harness({ streaming: busy === "streaming", compacting: busy === "compacting" });
    await h.start(); await h.command(""); await nextTask(); await h.command(""); await nextTask();
    h.ui.setEditorText("synthetic submitted prompt"); h.terminal.send(key);
    assert.equal(h.signals[0]!.aborted, true);
    h.raw.resolve("must not append late"); await h.controller.settled(); await nextTask();
    assert.equal(h.ui.getEditorText(), "");
    assert.equal(h.notices.filter((text) => text.includes("prompt submitted")).length, 1);
    assert.equal(h.main.signal.aborted, false);
  });
}

for (const mode of ["rpc", "print", "json"] as const) {
  test(`${mode}: factory/session/commands never load config, install editor, record or request`, async () => {
    const h = harness({ mode }); await h.start(); await h.command("");
    assert.equal(h.counts().loads, 0); assert.equal(h.counts().captures, 0);
    assert.equal(h.ui.getEditorComponent(), undefined); assert.equal(h.signals.length, 0);
  });
}

test("main Escape is forwarded, does not cancel dictation; distinct cancel clears UI once", async () => {
  const h = harness({ streaming: true }); await h.start(); h.f8(); await nextTask();
  h.terminal.send("\x1b");
  assert.equal(h.main.signal.aborted, true); assert.equal(h.signals[0]!.aborted, false);
  await h.command("cancel"); await h.command("cancel"); await h.controller.settled();
  assert.equal(h.notices.filter((text) => text === "Dictation cancelled.").length, 1);
  assert.equal(h.statuses.get(STATUS_KEY), undefined); assert.equal(h.widgets.get(WIDGET_KEY), undefined);
});

for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"] as const) {
  test(`${event} synchronously cancels even when later navigation could be vetoed`, async () => {
    const h = harness(); await h.start(); await h.command(""); await nextTask();
    const navigation = h.emit(event);
    assert.equal(h.signals[0]!.aborted, true); await navigation; await h.controller.settled();
    assert.equal(h.notices.filter((text) => text.includes("session changed")).length, 1);
  });
}

test("reload shutdown restores expanded editor, clears phase, cancels late correction and permits fresh operation", async () => {
  const h = harness(); h.config.correction.enabled = true;
  await h.start(); await h.command(""); await nextTask(); await h.command(""); await nextTask();
  h.raw.resolve("raw fixture"); await nextTask(); assert.equal(h.controller.phase, "correcting");
  h.ui.setEditorText("same draft");
  await h.emit("session_shutdown", { reason: "reload" });
  h.edited.resolve({ text: "obsolete correction", rawFallback: true }); await nextTask();
  assert.equal(h.ui.getEditorText(), "same draft"); assert.equal(h.ui.getEditorComponent(), undefined);
  assert.equal(h.notices.some((text) => text.includes("inserted raw")), false);
  await h.start(); h.f8(); await nextTask(); assert.equal(h.counts().captures, 2);
});

test("published elapsed counter and widget clear after cancellation with held cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(); await h.start(); await h.command(""); await nextTask();
  h.setClock(12000); t.mock.timers.tick(1000);
  assert.match(h.statuses.get(STATUS_KEY)!, /REC 00:12/);
  const clean = deferred<void>(); h.holdCleanup(clean.promise);
  await h.command("cancel"); await nextTask();
  assert.equal(h.statuses.get(STATUS_KEY), undefined); assert.equal(h.widgets.get(WIDGET_KEY), undefined);
  await h.command(""); assert.equal(h.counts().captures, 1);
  t.mock.timers.tick(5000); assert.equal(h.statuses.get(STATUS_KEY), undefined);
  clean.resolve(); await h.controller.settled();
});

test("editor factory takeover is not undone; owned capture is discarded and feedback cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(); await h.start(); await h.command(""); await nextTask();
  const other = () => h.mode.defaultEditor;
  h.ui.setEditorComponent(other);
  t.mock.timers.tick(1000); await h.controller.settled(); await nextTask();
  assert.equal(h.ui.getEditorComponent(), other);
  assert.equal(h.notices.filter((text) => text.includes("editor changed")).length, 1);
  assert.equal(h.statuses.get(STATUS_KEY), undefined); assert.equal(h.widgets.get(WIDGET_KEY), undefined);
});

test("temporary source/reloaded settings cannot change active operation; status/help echo no values", async () => {
  const h = harness(); await h.start(); await h.command(""); await nextTask();
  await h.command("source synthetic-new-source"); await h.command("status"); await h.command("help");
  assert.equal(h.settings[0]!.recorder.source, null);
  assert.equal(h.notices.some((text) => text.includes("synthetic-new-source")), false);
  await h.command(""); await nextTask(); h.raw.resolve("fixture"); await h.controller.settled();
});

test("invalid config and missing credential block capture; explicit config reload recovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-extension-config-test-"));
  try {
    const native = createPiUI();
    let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
    const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
    const notices: string[] = [];
    const ctx = { mode: "tui", hasUI: true, ui: { ...native.ui, notify: (text: string) => notices.push(text),
      setStatus: () => {}, setWidget: () => {} },
      sessionManager: SessionManager.inMemory("/synthetic"), isIdle: native.isIdle } as unknown as ExtensionContext;
    const store = new ConfigStore(dir);
    let starts = 0;
    const { controller } = registerDictation({ getCommands: native.pi.getCommands,
      on: (name: string, handler: any) => { handlers.set(name, handler); },
      registerCommand: (_name: string, value: typeof command) => { command = value; }, registerShortcut: () => {},
    } as unknown as ExtensionAPI, { store, key: (config) => {
      if (config.transcription.apiKeyEnv !== null) throw new Error("synthetic key details"); return undefined;
    }, record: () => { starts++; throw new Error("synthetic backend"); } });
    await writeFile(store.path, '{"unknown":"synthetic private value"}');
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    await command.handler("", ctx as ExtensionCommandContext); assert.equal(starts, 0);
    await writeFile(store.path, '{}'); await command.handler("reload", ctx as ExtensionCommandContext);
    await command.handler("", ctx as ExtensionCommandContext); assert.equal(starts, 0);
    assert.equal(notices.some((text) => text.includes("private value") || text.includes("key details")), false);
    await writeFile(store.path, '{"transcription":{"apiKeyEnv":null}}');
    await command.handler("reload", ctx as ExtensionCommandContext);
    // Add the unused registry so pre-start plain references are available.
    ctx.modelRegistry = {} as ModelRegistry;
    await command.handler("", ctx as ExtensionCommandContext); await controller.settled(); assert.equal(starts, 1);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx); native.stop();
    assert.equal(JSON.parse(await readFile(store.path, "utf8")).transcription.apiKeyEnv, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
