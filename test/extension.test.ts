/**
 * pi-oaistt extension tests
 *
 * Purpose: verify extension behavior without real audio, credentials or provider calls.
 * Strategy: combine synthetic inputs and controlled failures with relevant real APIs.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import { SessionManager, initTheme, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext,
  type ModelRegistry, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { ConfigStore, parseConfig, type Config } from "../src/config.ts";
import { registerDictation, STATUS_KEY, WIDGET_KEY, type Dependencies } from "../src/extension.ts";
import { createPiUI } from "./pi-ui-fixture.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fauxProvider, fauxAssistantMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { correct as realCorrect } from "../src/correction.ts";
import { DictationError } from "../src/operation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of open.splice(0).reverse()) await dispose(); });

function harness(options: { mode?: ExtensionContext["mode"]; streaming?: boolean; compacting?: boolean; fullscreen?: boolean;
  store?: Dependencies["store"]; sources?: Dependencies["sources"]; nativeFeedback?: boolean; nativeNotifications?: boolean; attempt?: Dependencies["transcribe"]; correction?: Dependencies["correct"]; bindings?: import("@earendil-works/pi-tui").KeybindingsConfig } = {}) {
  const native = createPiUI({ streaming: options.streaming, compacting: options.compacting,
    mode: options.fullscreen ? "fullscreen" : "regular", bindings: options.bindings, notifications: options.nativeNotifications });
  const notices: string[] = [];
  const categories: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const widgets = new Map<string, string[] | undefined>();
  const ui = { ...native.ui,
    notify: (text: string, category: "info" | "warning" | "error" = "info") => {
      categories.push(category); notices.push(text.replace(/\x1b\[[0-9;]*m/g, ""));
      if (options.nativeNotifications) native.ui.notify(text, category);
    },
    setStatus: (key: string, value: string | undefined) => {
      statuses.set(key, value); if (options.nativeFeedback) native.ui.setStatus(key, value);
    },
    setWidget: (key: string, value: unknown) => {
      assert.ok(value === undefined || Array.isArray(value)); widgets.set(key, value as string[] | undefined);
      if (options.nativeFeedback) native.ui.setWidget(key, value as string[] | undefined, { placement: "aboveEditor" });
    },
  };
  Object.defineProperty(ui, "theme", { get: () => native.ui.theme });
  const events = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
  const shortcuts = new Map<string, { handler(ctx: ExtensionContext): void | Promise<void> }>();
  const tools = new Map<string, any>();
  let config = parseConfig({ transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", auth: { type: "none" } } } }, correction: { automatic: false } });
  const ready = deferred<void>(); ready.resolve();
  const raw = deferred<string>();
  const edited = deferred<import("../src/correction.ts").CorrectionOutcome>();
  let cleanup: Promise<void> = Promise.resolve();
  const main = new AbortController();
  const signals: AbortSignal[] = [];
  const settings: Config[] = [];
  let captures = 0, disposals = 0, stops = 0, loads = 0;
  let clock = 0;
  let selectedModel: ExtensionContext["model"] | undefined;
  const correctionOptions: any[] = [], targets: string[] = [];
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
  Object.defineProperty(ctx, "model", { get: () => selectedModel });
  Object.defineProperty(native.session, "model", { get: () => selectedModel });
  const pi = {
    getCommands: native.pi.getCommands,
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      events.set(event, [...events.get(event) ?? [], handler]); return () => {};
    },
    registerCommand: (name: string, value: typeof command) => { assert.equal(name, "oaistt"); command = value; },
    registerShortcut: (key: string, value: { handler(ctx: ExtensionContext): void }) => { shortcuts.set(key, value); },
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI;
  const actualCorrection = options.correction;
  const result = registerDictation(pi, {
    store: options.store ?? { load: async () => { loads++; return config; }, setSource: (source) => { config = structuredClone(config); config.recorder.source = source; }, saveSource: async () => {}, saveProfile: async () => {} },
    prepare: async () => new Uint8Array(), key: () => undefined, clock: () => clock,
    sources: options.sources ?? (async () => []),
    record: (config, signal) => { captures++; signals.push(signal); settings.push(config);
      return { ready: ready.promise, stop: async () => { stops++; return { path: "/synthetic.wav", bytes: 100 }; },
        dispose: () => { disposals++; return cleanup; } };
    },
    transcribe: async (audio, config, signal, key, fetcher, profile, bytes) => { signals.push(signal); settings.push(config); return options.attempt ? options.attempt(audio, config, signal, key, fetcher, profile, bytes) : raw.promise; },
    correct: async (target, config, signal, session, registry, options) => {
      targets.push(target); correctionOptions.push(options); signals.push(signal); settings.push(config);
      return actualCorrection ? actualCorrection(target, config, signal, session, registry, options) : edited.promise;
    },
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
  native.mode.setupExtensionShortcuts({ getModelRegistry: () => ctx.modelRegistry, getShortcuts: () => shortcuts as any });
  native.mode.defaultEditor.onEscape = () => main.abort();
  open.push(async () => { await emit("session_shutdown", { reason: "quit" }); native.stop(); });
  return { ...native, ctx, ui, notices, categories, statuses, widgets, config, signals, settings, ready, raw, edited, main, emit,
    controller: result.controller,
    start: async () => { await emit("session_start", { reason: "startup" }); native.mode.setupExtensionShortcuts({ getModelRegistry: () => ctx.modelRegistry, getShortcuts: () => shortcuts as any }); },
    tools, targets, correctionOptions,
    setModel: (model: ExtensionContext["model"]) => { selectedModel = model; },
    selection: result.selection,
    f7: () => native.terminal.send("\x1b[18~"),
    f12: () => native.terminal.send("\x1b[24~"),
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
    await h.start(); await h.command("dictation toggle"); await nextTask(); await h.command("dictation toggle"); await nextTask();
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
    const h = harness({ mode }); await h.start(); await h.command("dictation toggle");
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
    const h = harness(); await h.start(); await h.command("dictation toggle"); await nextTask();
    const navigation = h.emit(event);
    assert.equal(h.signals[0]!.aborted, true); await navigation; await h.controller.settled();
    assert.equal(h.notices.filter((text) => text.includes("session changed")).length, 1);
  });
}

test("reload shutdown restores expanded editor, clears phase, cancels late correction and permits fresh operation", async () => {
  const h = harness(); h.config.correction.automatic = true;
  await h.start(); await h.command("dictation toggle"); await nextTask(); await h.command("dictation toggle"); await nextTask();
  h.raw.resolve("raw fixture"); await nextTask(); assert.equal(h.controller.phase, "correcting");
  h.ui.setEditorText("same draft");
  await h.emit("session_shutdown", { reason: "reload" });
  h.edited.resolve({ kind: "exhausted" }); await nextTask();
  assert.equal(h.ui.getEditorText(), "same draft"); assert.equal(h.ui.getEditorComponent(), undefined);
  assert.equal(h.notices.some((text) => text.includes("inserted raw")), false);
  await h.start(); h.f8(); await nextTask(); assert.equal(h.counts().captures, 2);
});

test("published elapsed counter and widget clear after cancellation with held cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(); await h.start(); await h.command("dictation toggle"); await nextTask();
  h.setClock(12000); t.mock.timers.tick(1000);
  assert.match(h.statuses.get(STATUS_KEY)!, /REC 00:12/);
  const clean = deferred<void>(); h.holdCleanup(clean.promise);
  await h.command("cancel"); await nextTask();
  assert.equal(h.statuses.get(STATUS_KEY), undefined); assert.equal(h.widgets.get(WIDGET_KEY), undefined);
  await h.command("dictation toggle"); assert.equal(h.counts().captures, 1);
  t.mock.timers.tick(5000); assert.equal(h.statuses.get(STATUS_KEY), undefined);
  clean.resolve(); await h.controller.settled();
});

test("editor factory takeover is not undone; owned capture is discarded and feedback cleared", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(); await h.start(); await h.command("dictation toggle"); await nextTask();
  const other = () => h.mode.defaultEditor;
  h.ui.setEditorComponent(other);
  t.mock.timers.tick(1000); await h.controller.settled(); await nextTask();
  assert.equal(h.ui.getEditorComponent(), other);
  assert.equal(h.notices.filter((text) => text.includes("editor changed")).length, 1);
  assert.equal(h.statuses.get(STATUS_KEY), undefined); assert.equal(h.widgets.get(WIDGET_KEY), undefined);
});

test("temporary source/reloaded settings cannot change active operation; status/help echo no values", async () => {
  const h = harness(); await h.start(); await h.command("dictation toggle"); await nextTask();
  await h.command("recorder source synthetic-new-source"); await h.command("status"); await h.command("help");
  assert.equal(h.settings[0]!.recorder.source, null);
  assert.equal(h.notices.some((text) => text.includes("synthetic-new-source")), false);
  await h.command("dictation toggle"); await nextTask(); h.raw.resolve("fixture"); await h.controller.settled();
});

test("invalid config blocks capture; explicit config reload recovers", async () => {
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
      registerCommand: (_name: string, value: typeof command) => { command = value; }, registerShortcut: () => {}, registerTool: () => {},
    } as unknown as ExtensionAPI, { store, prepare: async () => new Uint8Array(), key: (config) => {
      if (config.auth.type !== "none") throw new Error("synthetic key details"); return undefined;
    }, record: () => { starts++; throw new Error("synthetic backend"); } });
    await writeFile(store.path, '{"unknown":"synthetic private value"}');
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    await command.handler("dictation toggle", ctx as ExtensionCommandContext); assert.equal(starts, 0);
    await writeFile(store.path, '{}'); await command.handler("reload", ctx as ExtensionCommandContext);
    assert.equal(starts, 0);
    assert.equal(notices.some((text) => text.includes("private value") || text.includes("key details")), false);
    await writeFile(store.path, JSON.stringify({ transcription: { order: ['openai'], profiles: { openai: { endpoint: 'http://127.0.0.1:1/stt', model: 'fixture', auth: { type: 'none' } } } } }));
    await command.handler("reload", ctx as ExtensionCommandContext);
    // Add the unused registry so pre-start plain references are available.
    ctx.modelRegistry = {} as ModelRegistry;
    await command.handler("dictation toggle", ctx as ExtensionCommandContext); await controller.settled(); assert.equal(starts, 1);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx); native.stop();
    assert.equal(JSON.parse(await readFile(store.path, "utf8")).transcription.profiles.openai.auth.type, "none");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function sourceHarness(options: Parameters<typeof harness>[0] = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-source-command-test-"));
  open.push(() => rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore(dir);
  const original = { recorder: { maxDurationSeconds: 12 }, transcription: { order: ["openai"], profiles: { openai: { endpoint: "http://127.0.0.1:9000/v1/audio/transcriptions", model: "fixture-stt", auth: { type: "none" } } } }, correction: { automatic: false } };
  await writeFile(store.path, JSON.stringify(original));
  const h = harness({ ...options, store });
  await h.start();
  return { h, store, dir, original, disk: async () => JSON.parse(await readFile(store.path, "utf8")) };
}

test("source commands apply temporarily, explicitly save only source, and retain active settings", async () => {
  const { h, store, dir, original, disk } = await sourceHarness();
  await h.command("recorder source fixture-first"); assert.deepEqual(await disk(), original);
  await h.command("dictation toggle"); await nextTask();
  assert.equal(h.settings[0]!.recorder.source, "fixture-first");
  await h.command("recorder source fixture-second --save");
  assert.equal(h.settings[0]!.recorder.source, "fixture-first");
  assert.deepEqual(await disk(), { ...original, recorder: { ...original.recorder, source: "fixture-second" } });
  assert.equal((await new ConfigStore(dir).load()).recorder.source, "fixture-second");
  await h.command("recorder source default");
  assert.equal((await store.load()).recorder.source, null);
  assert.equal((await disk()).recorder.source, "fixture-second");
  await h.command("recorder source default --save"); assert.equal((await disk()).recorder.source, null);
  await h.command("cancel"); await h.controller.settled();
});

test("duplicate save flags and malformed controls cannot mutate source or disk", async () => {
  const { h, store, original, disk } = await sourceHarness();
  for (const args of ["source --save --save", "source fixture unexpected", "source fixture --save extra", "unknown fixture"]) {
    await h.command(args);
    assert.equal((await store.load()).recorder.source, null); assert.deepEqual(await disk(), original);
  }
  assert.equal(h.counts().captures, 0);
});







test("explicit settings reload updates the next operation, not active transcription routing", async () => {
  const { h, store, original } = await sourceHarness();
  await h.command("dictation toggle"); await nextTask();
  await writeFile(store.path, JSON.stringify({ ...original, transcription: { order: ["openai"], profiles: { openai: { endpoint: "http://127.0.0.1:9001/v1/audio/transcriptions", model: "whisper-1", auth: { type: "env", name: "OPENAI_API_KEY" } } } } }));
  await h.command("reload"); await h.command("dictation toggle"); await nextTask();
  assert.equal(h.settings[0]!.transcription.profiles.openai!.endpoint, original.transcription.profiles.openai.endpoint);
  assert.equal(h.settings[1]!.transcription.profiles.openai!.endpoint, original.transcription.profiles.openai.endpoint);
  h.raw.resolve("fixture"); await h.controller.settled();
  await h.command("dictation toggle"); await nextTask();
  assert.equal(h.settings.at(-1)!.transcription.profiles.openai!.endpoint, "http://127.0.0.1:9001/v1/audio/transcriptions");
});

test("processing feedback refreshes the current theme, not cached phase ANSI colors", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness(); await h.start(); await h.command("dictation toggle"); await nextTask(); await h.command("dictation toggle"); await nextTask();
  assert.equal(h.controller.phase, "transcribing");
  const before = h.statuses.get(STATUS_KEY);
  initTheme("light", false);
  const expected = h.ui.theme.fg("muted", "Transcribing…"); assert.notEqual(before, expected);
  t.mock.timers.tick(1000);
  assert.equal(h.statuses.get(STATUS_KEY), expected); assert.deepEqual(h.widgets.get(WIDGET_KEY), [expected]);
});

for (const fullscreen of [false, true]) for (const width of [12, 20, 80]) for (const replacement of [false, true]) {
  test(`native feedback rendering ${fullscreen ? "fullscreen" : "regular"}/${width}/${replacement ? "replacement" : "stock"} footer`, async () => {
    const h = harness({ fullscreen, nativeFeedback: true }); h.terminal.columns = width;
    const custom = { render: () => ["OTHER"], invalidate: () => {} };
    if (replacement) h.ui.setFooter(() => custom);
    await h.start(); await h.command("dictation toggle"); await nextTask();
    const widget = h.mode.widgetContainerAbove.render(width);
    const footer = h.mode.footerContainer.render(width);
    const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain(widget), /REC/); assert.match(plain(widget), /00:00/);
    assert.ok([...widget, ...footer].every((line) => visibleWidth(line) <= width));
    if (replacement) {
      assert.equal(h.mode.customFooter, custom); assert.equal(plain(footer), "OTHER");
    } else assert.match(plain(footer), /REC/);
    await h.command("cancel"); await h.controller.settled();
    assert.equal(h.footerStatuses.has(STATUS_KEY), false);
    assert.equal(plain(h.mode.widgetContainerAbove.render(width)).trim(), "");
    if (replacement) assert.equal(h.mode.customFooter, custom);
  });
}



test("editor takeover after delivery during held cleanup emits no false discard notice", async () => {
  const h = harness(); await h.start();
  const cleanup = deferred<void>(); h.holdCleanup(cleanup.promise);
  await h.command("dictation toggle"); await nextTask(); await h.command("dictation toggle"); await nextTask();
  h.raw.resolve("already delivered fixture"); await nextTask();
  assert.equal(h.ui.getEditorText(), "already delivered fixture"); assert.equal(h.controller.phase, "cleaning");
  h.ui.setEditorComponent(() => h.mode.defaultEditor);
  cleanup.resolve(); await h.controller.settled(); await nextTask();
  assert.equal(h.notices.some((text) => text.includes("editor changed")), false);
});

for (const fullscreen of [false, true]) for (const busy of ["idle", "streaming", "compacting"] as const) {
  test(`native F7 ${fullscreen}/${busy}: direct semantic replacement, no recorder/STT/main turn, undo`, async () => {
    const h = harness({ fullscreen, streaming: busy === "streaming", compacting: busy === "compacting" });
    await h.start(); h.ui.setEditorText("  typo @src/synthetic.ts\n/tmp/synthetic.png\n");
    h.ui.pasteToEditor("synthetic pasted line\n".repeat(15));
    const original = h.ui.getEditorText(), visible = h.mode.editor.getLines().join("\n");
    h.f7(); await nextTask(); assert.equal(h.controller.kind, "manual"); assert.equal(h.controller.phase, "correcting");
    assert.equal(h.counts().captures, 0); assert.equal(h.targets[0], original);
    h.edited.resolve({ kind: "corrected", text: original.replace("typo", "corrected") });
    await h.controller.settled(); assert.equal(h.ui.getEditorText(), original.replace("typo", "corrected"));
    assert.equal(h.main.signal.aborted, false); assert.equal(h.promptCalls.length, 0);
    h.terminal.send("\x1f"); assert.equal(h.ui.getEditorText(), original); assert.equal(h.mode.editor.getLines().join("\n"), visible);
    assert.equal(h.notices.some(n => n.includes("draft changed")), false);
  });
}
for (const mutation of ["typing", "paste", "set", "undo-revert", "submit-retype"] as const) {
  test(`F7 ${mutation}: eager abort and discarded late success without restoration`, async () => {
    const h = harness({ streaming: true }); await h.start(); h.ui.setEditorText("original"); h.f7(); await nextTask();
    if (mutation === "typing") h.terminal.send(" edited");
    if (mutation === "paste") h.ui.pasteToEditor("/tmp/synthetic.png");
    if (mutation === "set") h.ui.setEditorText("new programmatic");
    if (mutation === "undo-revert") { h.terminal.send("x"); h.terminal.send("\x1f"); }
    if (mutation === "submit-retype") { h.terminal.send("\r"); h.ui.setEditorText("original"); }
    const latest = h.ui.getEditorText(); assert.equal(h.signals[0]!.aborted, true);
    h.edited.resolve({ kind: "corrected", text: "obsolete" }); await h.controller.settled();
    assert.equal(h.ui.getEditorText(), latest); assert.equal(h.main.signal.aborted, false);
    assert.equal(h.notices.filter(n => n.includes("cancelled") || n.includes("discarded")).length, 1);
  });
}
test("F7 cursor/dialog focus and main Escape do not cancel; F12 cancels only oaistt", async () => {
  const h = harness({ streaming: true }); await h.start(); h.ui.setEditorText("draft"); h.f7(); await nextTask();
  h.terminal.send("\x1b[D"); h.terminal.send("\x1b"); assert.equal(h.main.signal.aborted, true); assert.equal(h.signals[0]!.aborted, false);
  const dialog = h.showDialog(); h.terminal.send("\r"); assert.equal(h.signals[0]!.aborted, false);
  h.tui.setFocus(h.mode.editor); h.f12(); assert.equal(h.signals[0]!.aborted, true);
  await h.controller.settled(); assert.equal(h.ui.getEditorText(), "draft");
});
for (const result of [{ kind: "exhausted" }, { kind: "thinking-error", message: "Synthetic thinking configuration error." }] as const) test(`manual ${result.kind} leaves draft untouched`, async () => {
  const h = harness(); await h.start(); h.ui.setEditorText("draft"); h.f7(); await nextTask();
  h.edited.resolve(result); await h.controller.settled(); assert.equal(h.ui.getEditorText(), "draft");
  assert.equal(h.notices.some(n => n.includes("inserted raw")), false);
});
test("manual empty/unchanged output creates no request/write or meaningless undo", async () => {
  const h = harness(); await h.start(); h.ui.setEditorText(" \n"); h.f7(); await nextTask(); assert.equal(h.targets.length, 0);
  h.ui.setEditorText("draft"); let writes = 0; h.mode.editor.onChange = () => writes++;
  h.f7(); await nextTask(); h.edited.resolve({ kind: "corrected", text: "draft" }); await h.controller.settled();
  assert.equal(writes, 0); assert.equal(h.ui.getEditorText(), "draft");
});
test("manual and dictation cannot restart/retarget one another; bare root is read-only help/status", async () => {
  const h = harness(); await h.start(); await h.command(""); assert.equal(h.controller.active, false); assert.equal(h.counts().captures, 0);
  h.ui.setEditorText("draft"); h.f7(); await nextTask(); h.f8(); await h.command("d start");
  assert.equal(h.controller.kind, "manual"); assert.equal(h.counts().captures, 0);
  h.f12(); await h.controller.settled(); h.f8(); await nextTask(); h.f7(); assert.equal(h.controller.kind, "dictation");
});
test("dictation marker is delivery-only and never appears in correction input", async () => {
  const h = harness(); h.config.delivery.dictationMarker = true; h.config.correction.automatic = true;
  await h.start(); h.f8(); await nextTask(); h.f8(); await nextTask(); h.raw.resolve("raw synthetic"); await nextTask();
  assert.equal(h.targets[0], "raw synthetic"); h.edited.resolve({ kind: "exhausted" }); await h.controller.settled();
  assert.equal(h.ui.getEditorText(), "this is dictated\n\nraw synthetic");
  h.terminal.send("\x1f"); assert.equal(h.ui.getEditorText(), "");
});
test("explicit current identity is frozen at recording start, not main-model/correction time", async () => {
  const h = harness(); h.config.correction.automatic = true; h.config.correction.order = ["$current"];
  h.setModel({ provider: "synthetic-a", id: "one" } as ExtensionContext["model"]);
  await h.start(); h.f8(); await nextTask(); h.setModel({ provider: "synthetic-b", id: "two" } as ExtensionContext["model"]);
  h.f8(); await nextTask(); h.raw.resolve("synthetic"); await nextTask();
  assert.deepEqual(h.correctionOptions[0].current, { provider: "synthetic-a", id: "one" });
  h.f12(); await h.controller.settled();
});
test("settings-only reload keeps manual frozen lease/request; full shutdown cancels it", async () => {
  const h = harness(); await h.start(); h.ui.setEditorText("draft"); h.f7(); await nextTask();
  h.setConfig(parseConfig({ correction: { order: ["new/model"] } })); await h.command("rl");
  assert.deepEqual(h.settings[0]!.correction.order, []); assert.equal(h.signals[0]!.aborted, false);
  await h.emit("session_shutdown", { reason: "reload" }); h.edited.resolve({ kind: "corrected", text: "late" }); await nextTask();
  assert.equal(h.ui.getEditorText(), "draft");
});
test("source no-name is read-only, unsupported verbs/aliases cannot start or mutate", async () => {
  const { h, original, disk } = await sourceHarness();
  for (const args of ["recorder source", "r s", "transcription source", "t s", "source fixture", "d s", "dictation", "transcription source --save"]) await h.command(args);
  assert.deepEqual(await disk(), original); assert.equal(h.mode.extensionInput, undefined); assert.equal(h.counts().captures, 0);
});
test("profile tools expose only bounded metadata and never audio/editor capabilities", async () => {
  const h = harness({ streaming: true }); await h.start(); h.ui.setEditorText("PRIVATE_SYNTHETIC_DRAFT");
  const result = await h.tools.get("oaistt_profiles").execute("test", {}, new AbortController().signal, undefined, h.ctx);
  const text = result.content[0].text; assert.doesNotMatch(text, /PRIVATE_SYNTHETIC_DRAFT|endpoint|auth|OPENAI_API_KEY/);
  await h.tools.get("oaistt_select_profile").execute("test", { name: "openai" }, new AbortController().signal, undefined, h.ctx);
  assert.equal(h.counts().captures, 0); assert.equal(h.targets.length, 0); assert.equal(h.ui.getEditorText(), "PRIVATE_SYNTHETIC_DRAFT");
  assert.equal(h.main.signal.aborted, false);
});

function profilesConfig() {
  return parseConfig({ transcription: { order: ["local", "remote"], automaticFallback: true, profiles: {
    local: { endpoint: "http://127.0.0.1:1/local", model: "same-label", auth: { type: "none" } },
    remote: { endpoint: "http://127.0.0.1:1/remote", model: "same-label", auth: { type: "none" } },
  } }, correction: { automatic: false } });
}
for (const newer of ["none", "choice", "reselect", "reload", "cancel"] as const) test(`integrated held STT fallback success versus newer ${newer}`, async () => {
  const held = deferred<string>(); let attempts = 0;
  const h = harness({ attempt: async (_audio, _config, _signal, _key, _fetcher, profile) => {
    attempts++; if (profile!.endpoint.endsWith("local")) throw new (await import("../src/transcription.ts")).TranscriptionFailure("network failure");
    return held.promise;
  } });
  h.setConfig(profilesConfig()); await h.start(); h.f8(); await nextTask(); h.f8(); await nextTask();
  assert.equal(attempts, 2); assert.equal(h.notices.filter(n => n.includes("trying remote")).length, 1);
  if (newer === "choice" || newer === "reselect") await h.command("t s local");
  if (newer === "reload") await h.command("rl");
  if (newer === "cancel") h.f12();
  held.resolve("synthetic"); await h.controller.settled();
  assert.equal(h.selection.selected, newer === "none" ? "remote" : "local");
  assert.equal(h.ui.getEditorText(), newer === "cancel" ? "" : "synthetic");
  await h.emit("session_shutdown", { reason: "switch" }); await h.start();
  assert.equal(h.selection.selected, newer === "none" ? "remote" : "local");
});
test("legitimate STT sticky preference survives later correction cancellation", async () => {
  const h = harness({ attempt: async (_a, _c, _s, _k, _f, p) => {
    if (p!.endpoint.endsWith("local")) throw new (await import("../src/transcription.ts")).TranscriptionFailure("network failure"); return "synthetic";
  } });
  const c = profilesConfig(); c.correction.automatic = true; h.setConfig(c);
  await h.start(); h.f8(); await nextTask(); h.f8(); await nextTask();
  assert.equal(h.controller.phase, "correcting"); assert.equal(h.selection.selected, "remote");
  h.f12(); await h.controller.settled(); assert.equal(h.selection.selected, "remote"); assert.equal(h.ui.getEditorText(), "");
});
test("failed settings reload blocks new work but allows owned frozen manual result", async () => {
  let failure = false;
  const config = parseConfig({});
  const h = harness({ store: { load: async () => { if (failure) throw new (await import("../src/config.ts")).ConfigError("Synthetic invalid configuration."); return config; }, setSource: () => {}, saveSource: async () => {}, saveProfile: async () => {} } });
  await h.start(); h.ui.setEditorText("draft"); h.f7(); await nextTask(); failure = true; await h.command("rl");
  assert.equal(h.signals[0]!.aborted, false); h.edited.resolve({ kind: "corrected", text: "corrected" }); await h.controller.settled();
  assert.equal(h.ui.getEditorText(), "corrected"); h.f8(); await nextTask(); assert.equal(h.counts().captures, 0);
  failure = false; await h.command("rl"); h.f8(); await nextTask(); assert.equal(h.counts().captures, 1);
});
test("own bindings replace/disable/multiple aliases; native conflicts are disabled, commands remain", async () => {
  const h = harness({ bindings: { "app.model.select": "f6" } });
  h.setConfig(parseConfig({ keybindings: { "dictation.toggle": ["f9", "f10"], "editor.correct": "f6", "operation.cancel": [] } }));
  await h.start(); h.f8(); await nextTask(); assert.equal(h.counts().captures, 0);
  h.terminal.send("\x1b[20~"); await nextTask(); assert.equal(h.counts().captures, 1);
  h.terminal.send("\x1b[21~"); await nextTask(); assert.equal(h.controller.phase, "transcribing");
  assert.ok(h.notices.some(n => n.includes("native control")));
  await h.command("x"); await h.controller.settled(); assert.equal(h.controller.active, false);
});
test("settings-only key changes stay pending, with old F8 continuing until full runtime setup", async () => {
  const h = harness(); await h.start(); h.setConfig(parseConfig({ keybindings: { "dictation.toggle": "f9" } }));
  await h.command("rl"); assert.ok(h.notices.some(n => n.includes("pending keys")));
  h.terminal.send("\x1b[20~"); await nextTask(); assert.equal(h.counts().captures, 0);
  h.f8(); await nextTask(); assert.equal(h.counts().captures, 1);
});

test("dictation thinking error is red plus guarded raw, not ordinary exhaustion notice", async () => {
  const h = harness(); h.config.correction.automatic = true; await h.start();
  h.f8(); await nextTask(); h.f8(); await nextTask(); h.raw.resolve("raw synthetic"); await nextTask();
  h.edited.resolve({ kind: "thinking-error", message: "Synthetic local thinking error." }); await h.controller.settled();
  assert.equal(h.ui.getEditorText(), "raw synthetic"); assert.ok(h.categories.includes("error"));
  assert.equal(h.notices.some(n => n.includes("inserted raw")), false);
});
test("new temporary/reselected choice wins while an earlier explicit save is held", async () => {
  const wait = deferred<void>(); let savedName: string | undefined; let disk = profilesConfig();
  const h = harness({ store: { load: async () => disk, setSource: () => {}, saveSource: async () => {},
    saveProfile: async name => { savedName = name; await wait.promise; disk = structuredClone(disk); disk.transcription.order = [name, ...disk.transcription.order.filter(n => n !== name)]; } } });
  await h.start(); const saving = h.command("t s remote --save"); await nextTask();
  await h.command("t s local"); wait.resolve(); await saving;
  assert.equal(savedName, "remote"); assert.equal(h.selection.selected, "local"); assert.equal(h.selection.metadata().default, "remote");
  assert.ok(h.notices.some(n => n.includes("next: local")));
});
test("nontui metadata tool may lazily load config but never initializes audio/editor", async () => {
  const h = harness({ mode: "rpc" }); await h.start(); assert.equal(h.counts().loads, 0);
  await h.tools.get("oaistt_profiles").execute("test", {}, new AbortController().signal, undefined, h.ctx);
  assert.equal(h.counts().loads, 1); assert.equal(h.counts().captures, 0); assert.equal(h.ui.getEditorComponent(), undefined);
});

for (const fullscreen of [false, true]) test(`help survives native info coalescing (${fullscreen ? "fullscreen" : "regular"})`, async () => {
  const h = harness({ fullscreen, nativeNotifications: true }); await h.start();
  h.ui.setEditorText("PRIVATE_SYNTHETIC_DRAFT");
  const entries = h.ctx.sessionManager.getEntries().length, counts = h.counts();
  for (const args of ["help", "h"]) {
    h.notices.length = 0; await h.command(args);
    const rendered = h.mode.chatContainer.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(rendered, /dictation toggle/); assert.match(rendered, /recorder sources/);
    assert.match(rendered, /transcription source NAME/); assert.match(rendered, /Defaults/);
    assert.match(rendered, /Active keys/); assert.match(rendered, /oaistt: idle/);
    assert.equal(h.notices.length, 1);
    assert.doesNotMatch(rendered, /PRIVATE_SYNTHETIC_DRAFT|https:|endpoint|OPENAI_API_KEY/);
    for (const width of [40, 80, 120]) for (const line of h.mode.chatContainer.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  h.notices.length = 0; await h.command("");
  assert.equal(h.notices.length, 1); assert.match(h.notices[0]!, /oaistt help/); assert.match(h.notices[0]!, /oaistt: idle/);
  assert.ok(h.notices[0]!.length < 1000); assert.equal(h.controller.active, false);
  assert.equal(h.ui.getEditorText(), "PRIVATE_SYNTHETIC_DRAFT");
  assert.deepEqual(h.counts(), counts); assert.equal(h.signals.length, 0); assert.equal(h.targets.length, 0);
  assert.equal(h.promptCalls.length, 0); assert.equal(h.main.signal.aborted, false);
  assert.equal(h.ctx.sessionManager.getEntries().length, entries);
});

test("help shows actual disabled/rebound controls and pending keys in one native-visible response", async () => {
  const h = harness({ nativeNotifications: true, bindings: { "app.model.select": "f6" } });
  h.setConfig(parseConfig({ keybindings: { "dictation.toggle": "f9", "editor.correct": "f6", "operation.cancel": [] } }));
  await h.start(); h.notices.length = 0; await h.command("help");
  const help = h.notices[0]!;
  assert.equal(h.notices.length, 1);
  assert.match(help, /dictation.toggle.*default: f8.*active: f9/);
  assert.match(help, /editor.correct.*default: f7.*active: unbound/);
  assert.match(help, /operation.cancel.*default: f12.*active: unbound/);
  h.setConfig(parseConfig({ keybindings: { "dictation.toggle": "f10" } }));
  await h.command("reload");
  for (const args of ["help", "", "status", "s"]) {
    h.notices.length = 0; await h.command(args);
    const rendered = h.mode.chatContainer.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(h.notices.length, 1);
    assert.match(rendered, /Active keys: dictation.toggle=f9/);
    assert.match(rendered, /Configured\/pending keys: dictation.toggle=f10/);
    assert.match(rendered, /Full Pi \/reload required/);
  }
  h.notices.length = 0; await h.command("--help");
  assert.equal(h.notices.length, 1); assert.equal(h.categories.at(-1), "error");
  assert.match(h.notices[0]!, /Defaults: F8 dictation toggle/);
  assert.equal(h.controller.active, false); assert.equal(h.counts().captures, 0);
});

for (const kind of ["dictation", "manual"] as const) test(`help/status during ${kind} is read-only and preserves active ownership`, async () => {
  const h = harness({ nativeNotifications: true, streaming: true }); await h.start();
  h.ui.setEditorText("synthetic draft"); if (kind === "dictation") h.f8(); else h.f7(); await nextTask();
  const counts = h.counts(), entries = h.ctx.sessionManager.getEntries().length;
  for (const args of ["", "help", "h", "status", "s"]) {
    await h.command(args);
    assert.equal(h.controller.kind, kind); assert.equal(h.signals[0]!.aborted, false);
    assert.match(h.notices.at(-1)!, kind === "dictation" ? /recording \(dictation\)/ : /correcting \(manual\)/);
    assert.equal(h.ui.getEditorText(), "synthetic draft");
  }
  assert.deepEqual(h.counts(), counts); assert.equal(h.main.signal.aborted, false);
  assert.equal(h.ctx.sessionManager.getEntries().length, entries); assert.equal(h.promptCalls.length, 0);
});

test("status-only output omits command help; extra help/status arguments stay invalid", async () => {
  const h = harness({ nativeNotifications: true }); await h.start();
  for (const args of ["status", "s"]) {
    h.notices.length = 0; await h.command(args);
    assert.equal(h.notices.length, 1); assert.match(h.notices[0]!, /oaistt: idle/);
    assert.match(h.notices[0]!, /Next recorder: server default/);
    assert.doesNotMatch(h.notices[0]!, /command help|dictation toggle|Defaults:/);
  }
  for (const args of ["help extra", "h extra", "status extra", "s extra"]) {
    h.notices.length = 0; await h.command(args);
    assert.equal(h.notices.length, 1); assert.equal(h.categories.at(-1), "error");
  }
  assert.equal(h.counts().captures, 0); assert.equal(h.signals.length, 0);
});

for (const automatic of [true, false]) for (const state of ["empty", "configured", "unavailable"] as const)
  for (const manual of [false, true]) test(`native F${manual ? 7 : 8}: automatic=${automatic}, ${state} order preserves delivery/notice policy`, async () => {
    const h = harness({ correction: realCorrect });
    const provider = fauxProvider({ provider: "fixture", models: [{ id: "correction" }] });
    let requests = 0;
    h.ctx.modelRegistry = {
      find: (name: string, id: string) => name === "fixture" ? provider.getModel(id) : undefined,
      streamSimple: () => { requests++; return { result: async () => fauxAssistantMessage("corrected synthetic") } as AssistantMessageEventStream; },
    } as unknown as ModelRegistry;
    h.config.correction.automatic = automatic;
    h.config.correction.order = state === "empty" ? [] : [state === "configured" ? "fixture/correction" : "missing/model"];
    h.setModel(provider.getModel("correction"));
    await h.start(); await h.command("status");
    assert.ok(h.notices.at(-1)!.includes(`Correction: automatic ${automatic ? "on" : "off"} (${h.config.correction.order.length} selectors).`));
    h.ui.setEditorText(manual ? "raw synthetic" : "");
    if (manual) h.f7();
    else { h.f8(); await nextTask(); h.f8(); h.raw.resolve("raw synthetic"); }
    await h.controller.settled();
    const attempt = automatic || manual;
    assert.equal(requests, attempt && state === "configured" ? 1 : 0);
    assert.equal(h.ui.getEditorText(), attempt && state === "configured" ? "corrected synthetic" : "raw synthetic");
    assert.equal(h.notices.filter(n => /Correction unavailable/.test(n)).length, attempt && state !== "configured" ? 1 : 0);
    assert.equal(h.main.signal.aborted, false);
  });

for (const action of ["recorder sources", "r l"]) {
  test(`${action}: preserve safe missing-tool diagnostics without capture or main-agent changes`, async () => {
    const message = "Missing audio tools: pactl (package: pulseaudio-utils)";
    const h = harness({ sources: async () => { throw new DictationError(message); } });
    await h.start(); await h.command(action);
    assert.equal(h.notices.at(-1), message); assert.equal(h.categories.at(-1), "error");
    assert.equal(h.counts().captures, 0); assert.equal(h.main.signal.aborted, false);
  });
}

test("source-list failures redact unknown errors rather than exposing backend stderr", async () => {
  const h = harness({ sources: async () => { throw new Error("EXCLUDED_SYNTHETIC_DIAGNOSTICS"); } });
  await h.start(); await h.command("recorder sources");
  assert.equal(h.notices.at(-1), "Cannot list recording sources; check Pulse server access.");
});
