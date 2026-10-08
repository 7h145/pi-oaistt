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
import { registerDictation, WIDGET_KEY, type Dependencies } from "../src/extension.ts";
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
function statusSection(text: string, title: string): string {
  const marker = `${title}:\n`, index = text.indexOf(marker);
  assert.ok(index >= 0, `Missing status section: ${title}`);
  return text.slice(index + marker.length).split("\n\n")[0]!;
}
function expectedProcessingText(theme: ExtensionContext["ui"]["theme"], phase: string, keys = "F12"): string {
  let text = `${theme.style("oaistt", { fg: "text", bold: true })} · ${phase}…`;
  if (keys) text += ` · ${theme.style(keys, { fg: "text", bold: true })} cancel`;
  return theme.fg("muted", text);
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of open.splice(0).reverse()) await dispose(); });

function harness(options: { mode?: ExtensionContext["mode"]; streaming?: boolean; compacting?: boolean; fullscreen?: boolean;
  identity?: Dependencies["identity"]; store?: Dependencies["store"]; sources?: Dependencies["sources"]; nativeWidgets?: boolean; nativeNotifications?: boolean; attempt?: Dependencies["transcribe"]; correction?: Dependencies["correct"]; bindings?: import("@earendil-works/pi-tui").KeybindingsConfig } = {}) {
  const native = createPiUI({ streaming: options.streaming, compacting: options.compacting,
    mode: options.fullscreen ? "fullscreen" : "regular", bindings: options.bindings, notifications: options.nativeNotifications });
  const notices: string[] = [];
  const styledNotices: string[] = [];
  const categories: string[] = [];
  const widgets = new Map<string, string[] | undefined>();
  const ui = { ...native.ui,
    notify: (text: string, category: "info" | "warning" | "error" = "info") => {
      categories.push(category); styledNotices.push(text); notices.push(text.replace(/\x1b\[[0-9;]*m/g, ""));
      if (options.nativeNotifications) native.ui.notify(text, category);
    },
    setStatus: () => { throw new Error("oaistt must not write footer statuses"); },
    setWidget: (key: string, value: unknown) => {
      assert.ok(value === undefined || Array.isArray(value)); widgets.set(key, value as string[] | undefined);
      if (options.nativeWidgets) native.ui.setWidget(key, value as string[] | undefined, { placement: "aboveEditor" });
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
    identity: options.identity ?? (async () => ({ version: "0.2.0" })),
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
  return { ...native, ctx, ui, notices, styledNotices, categories, widgets, widgetText: () => widgets.get(WIDGET_KEY)?.[0], config, signals, settings, ready, raw, edited, main, emit,
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
    assert.match(h.widgetText()!, /REC 00:00/); assert.ok(h.widgets.get(WIDGET_KEY));
    h.ui.setEditorText("typing continues\n"); h.f8(); await nextTask();
    assert.equal(h.controller.phase, "transcribing"); assert.equal(h.counts().captures, 1);
    h.raw.resolve("synthetic dictation"); await h.controller.settled(); await nextTask();
    assert.equal(h.ui.getEditorText(), "typing continues\nsynthetic dictation");
    assert.equal(h.promptCalls.length, 0); assert.equal(h.main.signal.aborted, false);
    assert.equal(h.widgets.get(WIDGET_KEY), undefined);
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
  assert.equal(h.widgets.get(WIDGET_KEY), undefined);
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
  assert.match(h.widgetText()!, /REC 00:12/);
  const clean = deferred<void>(); h.holdCleanup(clean.promise);
  await h.command("cancel"); await nextTask();
  assert.equal(h.widgets.get(WIDGET_KEY), undefined);
  await h.command("dictation toggle"); assert.equal(h.counts().captures, 1);
  t.mock.timers.tick(5000); assert.equal(h.widgetText(), undefined);
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
  assert.equal(h.widgets.get(WIDGET_KEY), undefined);
});

test("temporary source/reloaded settings cannot change active operation or its displayed capture device", async () => {
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
      setStatus: () => { throw new Error("oaistt must not write footer statuses"); }, setWidget: () => {} },
      sessionManager: SessionManager.inMemory("/synthetic"), isIdle: native.isIdle } as unknown as ExtensionContext;
    const store = new ConfigStore(dir);
    let starts = 0;
    const { controller } = registerDictation({ getCommands: native.pi.getCommands,
      on: (name: string, handler: any) => { handlers.set(name, handler); },
      registerCommand: (_name: string, value: typeof command) => { command = value; }, registerShortcut: () => {}, registerTool: () => {},
    } as unknown as ExtensionAPI, { identity: async () => ({ version: "0.2.0" }), store, prepare: async () => new Uint8Array(), key: (config) => {
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
  const before = h.widgetText();
  initTheme("light", false);
  const expected = expectedProcessingText(h.ui.theme, "transcribing"); assert.notEqual(before, expected);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.widgets.get(WIDGET_KEY), [expected]);
});

for (const fullscreen of [false, true]) for (const width of [12, 20, 80]) for (const replacement of [false, true]) {
  test(`widget-only feedback leaves ${replacement ? "custom" : "stock"} footer untouched: ${fullscreen ? "fullscreen" : "regular"}/${width}`, async () => {
    const h = harness({ fullscreen, nativeWidgets: true }); h.terminal.columns = width;
    h.footerStatuses.set("other-extension", "OTHER_STATUS");
    const custom = { render: () => ["OTHER"], invalidate: () => {} };
    if (replacement) h.ui.setFooter(() => custom);
    await h.start();
    const footerBefore = h.mode.footerContainer.render(width), statusesBefore = new Map(h.footerStatuses);
    await h.command("dictation toggle"); await nextTask();
    const widget = h.mode.widgetContainerAbove.render(width);
    const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain(widget), /REC/); assert.match(plain(widget), /00:00/);
    assert.ok(widget.every(line => visibleWidth(line) <= width));
    assert.deepEqual(h.mode.footerContainer.render(width), footerBefore);
    assert.deepEqual(h.footerStatuses, statusesBefore);
    assert.doesNotMatch(plain(h.mode.footerContainer.render(width)), /REC|oaistt|stop|cancel/);
    if (replacement) assert.equal(h.mode.customFooter, custom);
    await h.command("cancel"); await h.controller.settled();
    assert.equal(plain(h.mode.widgetContainerAbove.render(width)).trim(), "");
    assert.deepEqual(h.mode.footerContainer.render(width), footerBefore);
    assert.deepEqual(h.footerStatuses, statusesBefore);
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
test("manual and dictation cannot restart/retarget one another; bare root is read-only status", async () => {
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
test("no-name source/profile commands report selection and usage without mutation", async () => {
  const { h, original, disk } = await sourceHarness();
  for (const args of ["recorder source", "r s", "transcription profile", "t p"]) {
    await h.command(args);
    assert.equal(h.categories.at(-1), "info");
    assert.match(h.notices.at(-1)!, args.startsWith("r") ? /Recording source:.*Use recorder source NAME/
      : /Next transcription profile: openai.*Use transcription profile NAME/);
  }
  assert.deepEqual(await disk(), original); assert.equal(h.mode.extensionInput, undefined); assert.equal(h.counts().captures, 0);
});

for (const form of ["transcription profile", "t p"]) test(`${form}: temporary choice and explicit save share profile semantics`, async () => {
  const { h, original, disk, store } = await sourceHarness();
  const configured = { ...original, transcription: { ...original.transcription, order: ["openai", "remote"], profiles: {
    ...original.transcription.profiles, remote: { ...original.transcription.profiles.openai, model: "fixture-remote" },
  } } };
  await writeFile(store.path, JSON.stringify(configured)); await h.command("reload");
  h.ui.setEditorText("synthetic draft");
  await h.command(`${form} remote`);
  assert.equal(h.categories.at(-1), "info"); assert.equal(h.selection.selected, "remote");
  assert.deepEqual(await disk(), configured); assert.equal(h.counts().captures, 0);
  await h.command("dictation start"); await nextTask();
  await h.command(`${form} openai`); assert.equal(h.selection.selected, "openai");
  await h.command(`${form} remote --save`);
  assert.equal(h.selection.selected, "remote"); assert.equal(h.selection.metadata().default, "remote");
  assert.deepEqual(await disk(), { ...configured, transcription: { ...configured.transcription, order: ["remote", "openai"] } });
  assert.deepEqual(h.settings[0]!.transcription.order, ["openai", "remote"]);
  assert.equal(h.signals[0]!.aborted, false); assert.equal(h.ui.getEditorText(), "synthetic draft");
  assert.equal(h.main.signal.aborted, false); assert.equal(h.promptCalls.length, 0); assert.equal(h.targets.length, 0);
  await h.command("cancel"); await h.controller.settled();
});

test("profile grammar rejects obsolete/cross-domain forms and malformed arguments without mutation", async () => {
  const { h, original, disk } = await sourceHarness();
  const generation = h.selection.generation;
  for (const args of ["transcription source", "transcription source openai", "t s", "t s openai --save",
    "recorder profile openai", "r p openai", "t profile openai", "transcription p openai",
    "transcription profile --save", "t p --save", "t p openai unexpected", "t p openai --save --save",
    "transcription profile openai --save extra", "transcription profile missing", "source fixture", "d s", "dictation"]) {
    await h.command(args);
    assert.equal(h.categories.at(-1), "error", args);
    assert.equal(h.selection.selected, "openai"); assert.equal(h.selection.generation, generation);
    assert.deepEqual(await disk(), original);
  }
  assert.equal(h.counts().captures, 0); assert.equal(h.targets.length, 0); assert.equal(h.promptCalls.length, 0);
  assert.equal(h.main.signal.aborted, false);
});

for (const first of ["fixture/first", "$current"]) test(`help previews only first correction selector: ${first}`, async () => {
  const h = harness({ nativeNotifications: true, sources: async () => { throw new Error("help must not query audio"); } });
  h.config.correction.order = [first, "fixture/fallback"];
  h.setModel({ provider: "fixture", id: "main" } as ExtensionContext["model"]);
  if (first !== "$current") Object.defineProperty(h.ctx, "model", { get: () => { throw new Error("unauthorized main-model access"); } });
  h.ctx.modelRegistry = { find: () => { throw new Error("help must not probe models"); } } as unknown as ModelRegistry;
  await h.start(); await h.command("help");
  const text = h.notices.at(-1)!;
  const preview = text.split("\n").find(line => line.trimStart().startsWith("Correction model:"));
  assert.equal(preview, `  Correction model: ${first === "$current" ? "fixture/main" : first}`);
  assert.doesNotMatch(preview!, /→|fallback/);
  assert.doesNotMatch(text, /fixture\/fallback|Models, in order:|Active keys:|oaistt v0\.2\.0/);
  await h.command("status"); assert.match(h.notices.at(-1)!, /    • fixture\/fallback/);
  assert.equal(h.counts().captures, 0); assert.equal(h.signals.length, 0); assert.equal(h.targets.length, 0);
  assert.equal(h.ctx.sessionManager.getEntries().length, 0); assert.equal(h.promptCalls.length, 0);
});

test("help distinguishes missing current identity from unavailable configuration and sanitizes model labels", async () => {
  const h = harness(); h.config.correction.order = ["$current"];
  await h.start(); await h.command("help");
  assert.match(h.notices.at(-1)!, /Correction model: \$current \(unavailable\)/);
  h.setModel({ provider: "fixture\n", id: `model\x1b\x07\u202e${"x".repeat(100)}` } as ExtensionContext["model"]);
  await h.command("help");
  const line = h.notices.at(-1)!.split("\n").find(line => line.includes("Correction model:"))!;
  assert.equal(line, `  Correction model: fixture/model${"x".repeat(51)}`);
  h.selection.reset(); await h.command("help");
  assert.match(h.notices.at(-1)!, /Draft correction: configuration unavailable/);
  assert.doesNotMatch(h.notices.at(-1)!, /none is configured/);
});

test("help includes separate start/stop and multiple active keys, and refreshes theme per request", async () => {
  const h = harness({ nativeNotifications: true });
  h.setConfig(parseConfig({ keybindings: { "dictation.toggle": [], "dictation.start": ["f9", "shift+f9"], "dictation.stop": "f10" } }));
  await h.start(); await h.command("help");
  assert.match(h.notices.at(-1)!, /F9 \/ Shift\+F9\s+Start recording \(default: unbound\)/);
  assert.match(h.notices.at(-1)!, /F10\s+Stop and transcribe \(default: unbound\)/);
  const before = h.styledNotices.at(-1)!;
  initTheme("light", false); await h.command("help");
  assert.notEqual(h.styledNotices.at(-1), before);
  const prefix = h.ui.theme.style("Controls:", { fg: "text", bold: true }).split("Controls:")[0]!;
  assert.ok(h.styledNotices.at(-1)!.includes(`${prefix}Controls:`));
  for (const width of [32, 40, 80, 120]) for (const line of h.mode.chatContainer.render(width)) assert.ok(visibleWidth(line) <= width);
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
  if (newer === "choice" || newer === "reselect") await h.command("t p local");
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
  await h.start(); const saving = h.command("t p remote --save"); await nextTask();
  await h.command("t p local"); wait.resolve(); await saving;
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
    assert.match(rendered, /transcription profile NAME/); assert.match(rendered, /Controls:/);
    assert.doesNotMatch(rendered, /Active keys:|Configuration loaded successfully|oaistt v0\.2\.0/);
    assert.equal(h.notices.length, 1);
    const text = h.notices[0]!;
    assert.ok(text.startsWith("oaistt — speech to text and draft correction\n\nDictate into Pi’s prompt draft"));
    assert.ok(text.includes("oaistt never submits a prompt on its own."));
    assert.ok(text.includes("Draft correction needs a correction model; none is configured."));
    const sections = ["Controls:", "Abbreviations appear in parentheses:", "Dictation:", "Transcription:",
      "Capture device:", "Settings and help:", "Notes:"];
    const positions = sections.map(section => text.indexOf(section));
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]!)));
    assert.match(text, /\(d t\) means \/oaistt d t/);
    assert.match(text, /transcription profile NAME \[--save\] \(t p\)/);
    const heading = "Notes:", notes = [
      " • Without NAME, source/profile commands show the current selection and",
      "   usage without changing it.",
      " • Device/profile choices are temporary. Add --save to keep a choice in",
      "   configuration. Host audio settings remain unchanged.",
      " • Settings reload affects subsequent work only. Active dictation or",
      "   correction stays unchanged.",
      " • Key or extension-code changes require full Pi /reload. This cancels",
      "   dictation or correction in progress.",
    ];
    assert.deepEqual(text.split(`\n${heading}\n`)[1]!.split("\n"), notes);
    for (const line of notes) {
      assert.ok(visibleWidth(line) <= 72);
      if (line.includes("•")) assert.equal(line.indexOf("•"), heading.indexOf("o"));
      else assert.equal(line.search(/\S/u), 3);
    }
    // Wide terminals retain the explicit breaks and relative indentation.
    const wideLines = h.mode.chatContainer.render(180).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
    const notesIndex = wideLines.findIndex(line => line.trim() === "Notes:");
    assert.ok(notesIndex >= 0);
    const settingsHeading = wideLines.find(line => line.trim() === "Settings and help:")!;
    const headingIndent = wideLines[notesIndex]!.search(/\S/u);
    assert.equal(headingIndent, settingsHeading.search(/\S/u));
    assert.equal(wideLines[notesIndex]!.trimEnd(), " Notes:");
    // Compare displayed rows, including Pi's padding—not just the message text.
    for (const [index, note] of notes.entries()) {
      const line = wideLines[notesIndex + index + 1]!;
      assert.equal(line.trimEnd(), ` ${note}`);
      assert.equal(line.search(/\S/u) - headingIndent, note.search(/\S/u));
      if (line.includes("•")) assert.equal(line.indexOf("•"), wideLines[notesIndex]!.indexOf("o"));
    }
    assert.equal(text.split("Add --save").length - 1, 1);
    assert.ok(text.indexOf("Add --save") > text.indexOf("Notes:"));
    assert.doesNotMatch(text, /main agent|transcription source|\(t s\)|short forms also follow|not audio|Escape remains/);
    assert.match(text, /F8\s+Start or stop dictation/);
    assert.match(text, /F7\s+Correct the current draft/);
    assert.match(text, /F12\s+Cancel oaistt/);
    const styledHelp = h.styledNotices.at(-1)!;
    assert.ok(styledHelp.startsWith(h.ui.theme.getFgAnsi("muted")));
    assert.ok(!styledHelp.includes(h.ui.theme.getFgAnsi("accent")));
    for (const highlight of ["Controls:", "Dictation:", "Notes:", "F8", "/oaistt transcription profile NAME [--save] (t p)"]) {
      const prefix = h.ui.theme.style(highlight, { fg: "text", bold: true }).split(highlight)[0]!;
      assert.ok(styledHelp.includes(`${prefix}${highlight}`));
      assert.ok(h.mode.chatContainer.render(120).join("\n").includes(`${prefix}${highlight}`));
    }
    assert.doesNotMatch(rendered, /PRIVATE_SYNTHETIC_DRAFT|https:|endpoint|OPENAI_API_KEY/);
    for (const width of [40, 80, 120]) for (const line of h.mode.chatContainer.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  h.notices.length = 0; await h.command("");
  assert.equal(h.notices.length, 1); assert.match(h.notices[0]!, /oaistt help/); assert.match(h.notices[0]!, /oaistt v0\.2\.0: idle/);
  assert.ok(h.notices[0]!.length < 1000); assert.equal(h.controller.active, false);
  assert.equal(h.ui.getEditorText(), "PRIVATE_SYNTHETIC_DRAFT");
  assert.deepEqual(h.counts(), counts); assert.equal(h.signals.length, 0); assert.equal(h.targets.length, 0);
  assert.equal(h.promptCalls.length, 0); assert.equal(h.main.signal.aborted, false);
  assert.equal(h.ctx.sessionManager.getEntries().length, entries);
});

test("help shows actual controls; pending bindings remain in standalone status", async () => {
  const h = harness({ nativeNotifications: true, bindings: { "app.model.select": "f6" } });
  h.setConfig(parseConfig({ keybindings: { "dictation.toggle": "f9", "editor.correct": "f6", "operation.cancel": [] } }));
  await h.start(); h.notices.length = 0; await h.command("help");
  const help = h.notices[0]!;
  assert.equal(h.notices.length, 1);
  assert.match(help, /F9\s+Start or stop dictation \(default: F8\)/);
  assert.match(help, /unbound\s+Correct the current draft \(default: F7\)/);
  assert.match(help, /unbound\s+Cancel oaistt \(default: F12\)/);
  h.setConfig(parseConfig({ keybindings: { "dictation.toggle": "f10" } }));
  await h.command("reload");
  for (const args of ["help", "", "status", "s"]) {
    h.notices.length = 0; await h.command(args);
    const rendered = h.mode.chatContainer.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(h.notices.length, 1);
    if (args === "help") {
      assert.match(rendered, /F9\s+Start or stop dictation/);
      assert.doesNotMatch(rendered, /Active keys:|Configured\/pending keys:/);
    } else {
      assert.match(rendered, /Active keys:\s+• F9 — Start or stop dictation/);
      assert.match(rendered, /Configured\/pending keys:\s+• F10 — Start or stop dictation/);
      assert.match(rendered, /Full Pi \/reload required/);
    }
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
    if (["help", "h"].includes(args)) assert.doesNotMatch(h.notices.at(-1)!, /oaistt v0\.2\.0|Active keys:/);
    else assert.match(h.notices.at(-1)!, kind === "dictation" ? /recording \(dictation\)/ : /correcting \(manual\)/);
    assert.equal(h.ui.getEditorText(), "synthetic draft");
  }
  assert.deepEqual(h.counts(), counts); assert.equal(h.main.signal.aborted, false);
  assert.equal(h.ctx.sessionManager.getEntries().length, entries); assert.equal(h.promptCalls.length, 0);
});

test("bare root, whitespace root and status aliases render identical full status; help stays separate", async () => {
  const h = harness({ nativeNotifications: true }); h.setConfig(profilesConfig()); await h.start();
  const counts = h.counts(), entries = h.ctx.sessionManager.getEntries().length;
  let expected: string | undefined;
  for (const args of ["", "   ", "status", "s"]) {
    h.notices.length = 0; await h.command(args);
    assert.equal(h.notices.length, 1);
    const text = h.styledNotices.at(-1)!;
    expected ??= text; assert.equal(text, expected);
    assert.match(h.notices[0]!, /See \/oaistt help for commands and controls/);
    assert.doesNotMatch(h.notices[0]!, /Defaults:|Abbreviations appear|Settings and help:/);
  }
  for (const args of ["help", "h"]) {
    h.notices.length = 0; await h.command(args);
    assert.equal(h.notices.length, 1);
    assert.doesNotMatch(h.notices[0]!, /oaistt v0\.2\.0|Active keys:|Profiles, in order:|Models, in order:|Configuration loaded successfully/);
    assert.match(h.notices[0]!, /Settings and help:/);
  }
  assert.deepEqual(h.counts(), counts); assert.equal(h.ctx.sessionManager.getEntries().length, entries);
  assert.equal(h.signals.length, 0); assert.equal(h.targets.length, 0); assert.equal(h.main.signal.aborted, false);
});

for (const fallback of [false, true]) for (const selected of ["local", "remote"]) {
  test(`status previews effective STT order and bold start: fallback=${fallback}, selected=${selected}`, async () => {
    const h = harness({ sources: async () => { throw new Error("status must not query audio"); } });
    const config = profilesConfig(); config.transcription.automaticFallback = fallback;
    h.setConfig(config); await h.start(); await h.command(`t p ${selected}`);
    Object.defineProperty(h.ctx, "model", { get: () => { throw new Error("unauthorized main identity access"); } });
    h.ctx.modelRegistry = { find: () => { throw new Error("status must not probe models"); } } as unknown as ModelRegistry;
    const counts = h.counts(), generation = h.selection.generation;
    await h.command("status");
    const section = statusSection(h.notices.at(-1)!, "Transcription");
    const expected = fallback && selected === "local" ? ["local", "remote"] : [selected];
    assert.deepEqual(section.split("    • ").slice(1).map(line => line.split("\n")[0]), expected);
    assert.match(section, /Default:  local/);
    assert.ok(section.includes(`Fallback: ${fallback ? "on" : "off"}`));
    const prefix = h.ui.theme.style(selected, { fg: "text", bold: true }).split(selected)[0]!;
    assert.ok(h.styledNotices.at(-1)!.includes(`    • ${prefix}${selected}`));
    assert.doesNotMatch(h.notices.at(-1)!, /\[next\]|\[selected\]/);
    assert.deepEqual(h.counts(), counts); assert.equal(h.selection.generation, generation);
    assert.equal(h.signals.length, 0); assert.equal(h.targets.length, 0); assert.equal(h.promptCalls.length, 0);
  });
}

test("active dictation profile stays separate from a newer next-operation chain", async () => {
  const h = harness(); h.setConfig(profilesConfig()); await h.start(); h.f8(); await nextTask();
  await h.command("t p remote"); await h.command("status");
  const section = statusSection(h.notices.at(-1)!, "Transcription");
  assert.equal(section, "  Active:   local\n  Default:  local\n  Fallback: on\n  Profiles, in order:\n    • remote");
  assert.equal(h.signals[0]!.aborted, false); assert.equal(h.counts().captures, 1);
  assert.deepEqual(h.settings[0]!.transcription.order, ["local", "remote"]);
  await h.command("cancel"); await h.controller.settled();
});

test("status-only output omits command help; extra help/status arguments stay invalid", async () => {
  const h = harness({ nativeNotifications: true }); await h.start();
  for (const args of ["status", "s"]) {
    h.notices.length = 0; await h.command(args);
    assert.equal(h.notices.length, 1); assert.match(h.notices[0]!, /oaistt v0\.2\.0: idle/);
    assert.match(h.notices[0]!, /Capture device:\s+server default source/);
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
    assert.match(statusSection(h.notices.at(-1)!, "Correction"), new RegExp(`Automatic: ${automatic ? "on" : "off"}`));
    assert.ok(h.notices.at(-1)!.includes(state === "empty" ? "none (no requests)" : h.config.correction.order[0]!));
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

for (const fullscreen of [false, true]) test(`status has neutral headings, ordered bullet lists, bold first candidates and explicit fallback (${fullscreen ? "fullscreen" : "regular"})`, async () => {
  const h = harness({ fullscreen, nativeNotifications: true });
  const config = profilesConfig();
  config.correction.automatic = true;
  config.correction.order = ["fixture/first", "$current", "fixture/last/slashed/語"];
  h.setConfig(config);
  const provider = fauxProvider({ provider: "fixture", models: [{ id: "main" }] });
  h.setModel(provider.getModel("main"));
  h.ctx.modelRegistry = { find: () => { throw new Error("status must not probe models"); } } as unknown as ModelRegistry;
  await h.start(); h.ui.setEditorText("EXCLUDED_SYNTHETIC_DRAFT");
  const counts = h.counts(), entries = h.ctx.sessionManager.getEntries().length;
  for (const args of ["", "status", "s"]) {
    await h.command(args);
    const text = h.notices.at(-1)!;
    assert.equal(statusSection(text, "Transcription"), "  Active:   none\n  Default:  local\n  Fallback: on\n  Profiles, in order:\n    • local\n    • remote");
    assert.equal(statusSection(text, "Correction"), "  Automatic: on\n  Models, in order:\n    • fixture/first\n    • $current (fixture/main)\n    • fixture/last/slashed/語");
    assert.match(text, /Capture device:\s+server default source/);
    const titles = ["Transcription", "Correction", "Capture device", "Active keys"];
    const positions = titles.map(title => text.indexOf(`${title}:`));
    assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1]!)));
    assert.doesNotMatch(text, /EXCLUDED_SYNTHETIC_DRAFT|https?:|OPENAI_API_KEY|Active STT|selectors|\[next\]|\[selected\]|Config:|ready/);
    assert.match(text, /Configuration loaded successfully\./);
    const styled = h.styledNotices.at(-1)!;
    assert.ok(styled.startsWith(h.ui.theme.getFgAnsi("muted")));
    assert.ok(!styled.includes(h.ui.theme.getFgAnsi("accent")));
    for (const highlight of [...titles.map(title => `${title}:`), "local", "fixture/first", "F8", "F7", "F12"]) {
      const prefix = h.ui.theme.style(highlight, { fg: "text", bold: true }).split(highlight)[0]!;
      assert.match(prefix, /\x1b\[/);
      assert.ok(styled.includes(`${prefix}${highlight}`));
      assert.ok(h.mode.chatContainer.render(120).join("\n").includes(`${prefix}${highlight}`));
    }
    for (const ordinary of ["remote", "$current (fixture/main)", "fixture/last/slashed/語", "unbound"]) {
      const prefix = h.ui.theme.style(ordinary, { fg: "text", bold: true }).split(ordinary)[0]!;
      assert.ok(!styled.includes(`${prefix}${ordinary}`));
    }
    assert.match(text, /Active keys:\n  • F8 — Start or stop dictation\n  • F7 — Correct the current draft\n  • F12 — Cancel oaistt\n  • unbound — Start recording\n  • unbound — Stop and transcribe/);
    for (const width of [32, 40, 80, 120]) for (const line of h.mode.chatContainer.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  assert.deepEqual(h.counts(), counts); assert.equal(h.signals.length, 0); assert.equal(h.targets.length, 0);
  assert.equal(h.ui.getEditorText(), "EXCLUDED_SYNTHETIC_DRAFT"); assert.equal(h.promptCalls.length, 0);
  assert.equal(h.ctx.sessionManager.getEntries().length, entries); assert.equal(h.main.signal.aborted, false);
});

test("status shows the selected capture device alongside disabled transcription fallback", async () => {
  const h = harness();
  h.setConfig(parseConfig({ recorder: { source: "fixture.capture.source" }, transcription: {
    ...profilesConfig().transcription, automaticFallback: false,
  } }));
  await h.start(); await h.command("status");
  assert.match(statusSection(h.notices.at(-1)!, "Transcription"), /Fallback: off/);
  assert.doesNotMatch(h.notices.at(-1)!, /^Fallback:/m);
  assert.match(h.notices.at(-1)!, /Capture device:\s+fixture\.capture\.source/);
  assert.match(statusSection(h.notices.at(-1)!, "Correction"), /Automatic: on\n  Models, in order:\n    none \(no requests\)/);
  assert.doesNotMatch(h.notices.at(-1)!, /Recorder:|next capture:/);
});

test("status does not read the main model unless $current is explicitly configured", async () => {
  const h = harness(); await h.start();
  Object.defineProperty(h.ctx, "model", { get: () => { throw new Error("unauthorized main-model access"); } });
  for (const args of ["", "help", "status", "s"]) await h.command(args);
  assert.match(h.notices.at(-1)!, /none \(no requests\)/);
});

test("status marks missing current model and unavailable config without claiming loaded configuration or defaults", async () => {
  const h = harness(); h.config.correction.order = ["$current"];
  await h.start(); await h.command("status");
  assert.match(h.notices.at(-1)!, /\$current \(unavailable\)/);
  h.selection.reset(); await h.command("status");
  assert.match(h.notices.at(-1)!, /Configuration unavailable/);
  assert.match(statusSection(h.notices.at(-1)!, "Correction"), /Automatic: unavailable\n  Models, in order:\n    unavailable/);
  assert.match(statusSection(h.notices.at(-1)!, "Transcription"), /Default:  unavailable\n  Fallback: unavailable\n  Profiles, in order:\n    unavailable/);
  assert.match(h.notices.at(-1)!, /Capture device:\s+unavailable/);
  assert.doesNotMatch(h.notices.at(-1)!, /Automatic: off|server default source|loaded successfully/);
});

test("status previews next current-model identity without retargeting frozen work", async () => {
  const h = harness(); h.config.correction.automatic = true; h.config.correction.order = ["$current"];
  const provider = fauxProvider({ provider: "fixture", models: [{ id: "first" }, { id: "second" }] });
  h.setModel(provider.getModel("first")); await h.start(); h.f8(); await nextTask();
  h.setModel(provider.getModel("second")); await h.command("status");
  assert.match(h.notices.at(-1)!, /Models, in order:\n    • \$current \(fixture\/second\)/);
  h.f8(); h.raw.resolve("synthetic text"); await nextTask();
  assert.deepEqual(h.correctionOptions[0]!.current, { provider: "fixture", id: "first" });
  h.edited.resolve({ kind: "corrected", text: "synthetic corrected" }); await h.controller.settled();
  assert.equal(h.ui.getEditorText(), "synthetic corrected");
});

test("status model labels strip controls and bound long identities", async () => {
  const h = harness(); h.config.correction.order = ["$current", `fixture/${"x".repeat(200)}`];
  h.setModel({ provider: "fixture\n", id: "model\x1b\x07\u202e\nEND" } as ExtensionContext["model"]);
  await h.start(); await h.command("status");
  const text = h.notices.at(-1)!;
  assert.match(text, /\$current \(fixture\/modelEND\)/);
  assert.ok(text.includes(`fixture/${"x".repeat(56)}`));
  assert.doesNotMatch(text, /x{57}|\x07|\x1b|\u202e/);
});

test("status labels use the current theme on each request", async () => {
  const h = harness(); await h.start(); await h.command("status");
  const before = h.styledNotices.at(-1)!;
  initTheme("light", false);
  await h.command("status");
  const prefix = h.ui.theme.style("Transcription:", { fg: "text", bold: true }).split("Transcription:")[0]!;
  assert.ok(h.styledNotices.at(-1)!.includes(`${prefix}Transcription:`));
  assert.notEqual(h.styledNotices.at(-1), before);
});

for (const initial of [null, "fixture.capture.first"]) test(`capture device status keeps frozen dictation source: ${initial ?? "default"}`, async () => {
  const h = harness(); h.config.recorder.source = initial;
  await h.start(); h.f8(); await nextTask();
  assert.equal(h.controller.captureSource, initial);
  await h.command("recorder source fixture.capture.second");
  for (const args of ["status", ""]) {
    await h.command(args);
    assert.ok(h.notices.at(-1)!.includes(initial ?? "server default source"));
    assert.doesNotMatch(h.notices.at(-1)!, /fixture\.capture\.second/);
  }
  h.selection.reset(); await h.command("status"); // Failed reload must not hide owned capture metadata.
  assert.match(h.notices.at(-1)!, /Configuration unavailable/);
  assert.ok(h.notices.at(-1)!.includes(initial ?? "server default source"));
  await h.command("reload");
  await h.command("cancel"); await h.controller.settled();
  assert.equal(h.controller.captureSource, undefined);
  await h.command("status");
  assert.match(h.notices.at(-1)!, /Capture device:\s+fixture\.capture\.second/);
  assert.equal(h.main.signal.aborted, false); assert.equal(h.promptCalls.length, 0);
});

test("capture device status uses selected settings during manual correction, without capture or probing", async () => {
  const h = harness({ sources: async () => { throw new Error("status must not query audio"); } });
  h.config.recorder.source = "fixture.capture.first";
  await h.start(); h.ui.setEditorText("synthetic draft"); h.f7(); await nextTask();
  assert.equal(h.controller.captureSource, undefined);
  await h.command("recorder source fixture.capture.second"); await h.command("status");
  assert.match(h.notices.at(-1)!, /Capture device:\s+fixture\.capture\.second/);
  assert.equal(h.counts().captures, 0);
  await h.command("cancel"); await h.controller.settled();
});

test("capture device labels are control-stripped and bounded", async () => {
  const h = harness(); h.config.recorder.source = `fixture\x1b\x07\u202e${"x".repeat(100)}`;
  await h.start(); await h.command("status");
  const source = statusSection(h.notices.at(-1)!, "Capture device");
  assert.equal(source, `  fixture${"x".repeat(57)}`);
});

for (const commit of [undefined, "1234abc"]) test(`status identifies loaded installation, optional commit=${commit ?? "none"}`, async () => {
  let reads = 0;
  const h = harness({ identity: async () => { reads++; return { version: "0.2.0", commit }; } });
  assert.equal(reads, 0); // No factory/import probe.
  await h.start();
  for (const args of ["", "status", "s", "reload"]) {
    await h.command(args);
    assert.ok(h.notices.at(-1)!.includes(`oaistt v0.2.0${commit ? ` (${commit})` : ""}: idle. Configuration loaded successfully.`));
  }
  await h.emit("session_shutdown", { reason: "reload" }); await h.start(); await h.command("status");
  assert.equal(reads, 1);
  assert.equal(h.counts().captures, 0); assert.equal(h.promptCalls.length, 0); assert.equal(h.main.signal.aborted, false);
});

test("installation metadata failure cannot block settings or capture controls", async () => {
  const h = harness({ identity: async () => { throw new Error("EXCLUDED_SYNTHETIC_METADATA"); } });
  await h.start(); await h.command("status");
  assert.match(h.notices.at(-1)!, /oaistt: idle\. Configuration loaded successfully/);
  assert.doesNotMatch(h.notices.at(-1)!, /EXCLUDED_SYNTHETIC_METADATA/);
  h.f8(); await nextTask(); assert.equal(h.controller.phase, "recording");
  await h.command("cancel"); await h.controller.settled();
});

for (const mode of ["rpc", "json", "print"] as const) test(`non-TUI ${mode} does not probe installation identity`, async () => {
  let reads = 0;
  const h = harness({ mode, identity: async () => { reads++; return { version: "0.2.0" }; } });
  await h.start(); assert.equal(reads, 0);
});

const startupCases = [
  { name: "defaults", keys: {}, hints: "F8 to dictate · F7 to correct · F12 to cancel" },
  { name: "rebound", keys: { "dictation.toggle": "f9", "editor.correct": "f10", "operation.cancel": "f11" }, hints: "F9 to dictate · F10 to correct · F11 to cancel" },
  { name: "toggle wins", keys: { "dictation.start": "f9", "dictation.stop": "f10" }, hints: "F8 to dictate · F7 to correct · F12 to cancel" },
  { name: "separate start/stop", keys: { "dictation.toggle": [], "dictation.start": "f9", "dictation.stop": "f10" }, hints: "F9 to start dictation · F10 to stop dictation · F7 to correct · F12 to cancel" },
  { name: "missing stop", keys: { "dictation.toggle": [], "dictation.start": "f9" }, hints: "F7 to correct · F12 to cancel" },
  { name: "missing start", keys: { "dictation.toggle": [], "dictation.stop": "f10" }, hints: "F7 to correct · F12 to cancel" },
  { name: "no dictation", keys: { "dictation.toggle": [] }, hints: "F7 to correct · F12 to cancel" },
  { name: "no correction", keys: { "editor.correct": [] }, hints: "F8 to dictate · F12 to cancel" },
  { name: "no cancellation", keys: { "operation.cancel": [] }, hints: "F8 to dictate · F7 to correct" },
  { name: "all disabled", keys: { "dictation.toggle": [], "editor.correct": [], "operation.cancel": [] }, hints: "" },
  { name: "multiple bindings and punctuation", keys: { "dictation.toggle": ["f8", "shift+f8", "+"] }, hints: "F8 / Shift+F8 / + to dictate · F7 to correct · F12 to cancel" },
  { name: "native toggle conflict", keys: { "dictation.toggle": "f6", "dictation.start": "f9", "dictation.stop": "f10" }, hints: "F9 to start dictation · F10 to stop dictation · F7 to correct · F12 to cancel", native: { "app.model.select": "f6" } },
  { name: "native start conflict", keys: { "dictation.toggle": [], "dictation.start": "f6", "dictation.stop": "f10" }, hints: "F7 to correct · F12 to cancel", native: { "app.model.select": "f6" } },
  { name: "ambiguous toggle/correction", keys: { "dictation.toggle": "f8", "editor.correct": "f8" }, hints: "F12 to cancel" },
] as const;
for (const fullscreen of [false, true]) for (const row of startupCases) {
  test(`single-line startup tagline: ${row.name}, ${fullscreen ? "fullscreen" : "regular"}`, async () => {
    const h = harness({ fullscreen, nativeNotifications: true, bindings: "native" in row ? row.native : undefined });
    h.setConfig(parseConfig({ keybindings: row.keys }));
    await h.start();
    const banners = h.notices.filter(text => text.startsWith("oaistt — speech to text"));
    assert.deepEqual(banners, [`oaistt — speech to text${row.hints ? ` · ${row.hints}` : ""} · see /oaistt help`]);
    assert.doesNotMatch(banners[0]!, /\n|ready|Defaults|unbound/);
    const rendered = h.mode.chatContainer.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(rendered, /oaistt — speech to text/); assert.match(rendered, /see\s+\/oaistt\s+help/);
    for (const width of [32, 40, 80, 120]) for (const line of h.mode.chatContainer.render(width)) assert.ok(visibleWidth(line) <= width);
    const prefix = h.ui.theme.style("oaistt", { fg: "text", bold: true }).split("oaistt")[0]!;
    const styled = h.styledNotices.at(-1)!;
    assert.ok(styled.startsWith(`${prefix}oaistt`));
    assert.ok(styled.includes(h.ui.theme.fg("dim", " — speech to text")));
    assert.ok(styled.includes(h.ui.theme.fg("dim", " · ")));
    assert.ok(styled.endsWith(h.ui.theme.fg("dim", "see /oaistt help")));
    for (const hint of row.hints ? row.hints.split(" · ") : []) {
      const [, keys, description] = hint.match(/^(.*?) (to .*)$/)!;
      assert.ok(styled.includes(h.ui.theme.style(keys!, { fg: "text", bold: true }) + h.ui.theme.fg("dim", ` ${description}`)));
    }
    if (row.name === "defaults") {
      const keyPrefix = h.ui.theme.style("F8", { fg: "text", bold: true }).split("F8")[0]!;
      assert.ok(h.mode.chatContainer.render(120).join("\n").includes(`${keyPrefix}F8`));
    }
    assert.equal(h.counts().captures, 0); assert.equal(h.targets.length, 0); assert.equal(h.promptCalls.length, 0);
    assert.equal(h.main.signal.aborted, false); assert.equal(h.ctx.sessionManager.getEntries().length, 0);
  });
}

const recordingCases = [
  { name: "defaults", keys: {}, hints: "F8 stop · F12 cancel" },
  { name: "toggle wins", keys: { "dictation.start": "f9", "dictation.stop": "f10" }, hints: "F8 stop · F12 cancel" },
  { name: "rebound", keys: { "dictation.toggle": "f9", "operation.cancel": "f11" }, hints: "F9 stop · F11 cancel" },
  { name: "start/stop pair", keys: { "dictation.toggle": [], "dictation.start": "f9", "dictation.stop": "f10" }, hints: "F10 stop · F12 cancel" },
  { name: "stop without start", keys: { "dictation.toggle": [], "dictation.stop": "f10" }, hints: "F10 stop · F12 cancel" },
  { name: "start without stop", keys: { "dictation.toggle": [], "dictation.start": "f9" }, hints: "F12 cancel" },
  { name: "no cancellation", keys: { "operation.cancel": [] }, hints: "F8 stop" },
  { name: "all disabled", keys: { "dictation.toggle": [], "dictation.start": [], "dictation.stop": [], "editor.correct": [], "operation.cancel": [] }, hints: "" },
  { name: "multiple toggles and punctuation", keys: { "dictation.toggle": ["f8", "shift+f8", "+"] }, hints: "F8 / Shift+F8 / + stop · F12 cancel" },
  { name: "multiple stop keys", keys: { "dictation.toggle": [], "dictation.stop": ["f9", "shift+f9"] }, hints: "F9 / Shift+F9 stop · F12 cancel" },
  { name: "native toggle conflict", keys: { "dictation.toggle": "f6", "dictation.stop": "f10" }, hints: "F10 stop · F12 cancel", native: { "app.model.select": "f6" } },
  { name: "native stop conflict", keys: { "dictation.toggle": [], "dictation.start": "f9", "dictation.stop": "f6" }, hints: "F12 cancel", native: { "app.model.select": "f6" } },
  { name: "native cancel conflict", keys: { "operation.cancel": "f6" }, hints: "F8 stop", native: { "app.model.select": "f6" } },
  { name: "own toggle/cancel conflict", keys: { "dictation.toggle": "f8", "operation.cancel": "f8", "dictation.stop": "f10" }, hints: "F10 stop" },
] as const;
for (const fullscreen of [false, true]) for (const row of recordingCases) {
  test(`recording guidance: ${row.name}, ${fullscreen ? "fullscreen" : "regular"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness({ fullscreen, nativeWidgets: true, bindings: "native" in row ? row.native : undefined });
    h.setConfig(parseConfig({ keybindings: row.keys }));
    Object.defineProperty(h.ctx, "model", { get: () => { throw new Error("guidance must not read main identity"); } });
    h.ctx.modelRegistry = { find: () => { throw new Error("guidance must not probe models"); } } as unknown as ModelRegistry;
    await h.start(); await h.command("dictation start"); await nextTask();
    h.setClock(5000); t.mock.timers.tick(1000);
    const text = h.widgetText()!, plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    const expected = `● REC 00:05 · oaistt${row.hints ? ` · ${row.hints}` : ""}`;
    assert.equal(plain, expected); assert.doesNotMatch(plain, /\n|to stop|to cancel|start|correct|unbound|ready/);
    assert.deepEqual(h.widgets.get(WIDGET_KEY), [text]);
    const indicator = h.ui.theme.fg("error", "● REC 00:05");
    assert.ok(text.startsWith(indicator));
    const guidance = text.slice(indicator.length);
    assert.ok(guidance.startsWith(h.ui.theme.getFgAnsi("muted")));
    assert.ok(!guidance.includes(h.ui.theme.getFgAnsi("error")));
    const prefix = h.ui.theme.style("oaistt", { fg: "text", bold: true }).split("oaistt")[0]!;
    assert.ok(guidance.includes(`${prefix}oaistt`));
    for (const block of row.hints.split(" · ").filter(Boolean)) {
      const keys = block.replace(/ (stop|cancel)$/u, "");
      const keyPrefix = h.ui.theme.style(keys, { fg: "text", bold: true }).split(keys)[0]!;
      assert.ok(guidance.includes(`${keyPrefix}${keys}`));
    }
    const native = h.mode.widgetContainerAbove.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(native.includes(expected));
    for (const width of [32, 40, 80, 120]) for (const line of h.mode.widgetContainerAbove.render(width)) assert.ok(visibleWidth(line) <= width);
    assert.equal(h.counts().captures, 1); assert.equal(h.signals[0]!.aborted, false);
    assert.equal(h.promptCalls.length, 0); assert.equal(h.main.signal.aborted, false);
    await h.command("cancel"); await h.controller.settled();
    assert.equal(h.widgets.get(WIDGET_KEY), undefined);
  });
}

test("recording guidance refreshes theme and elapsed time but ignores pending configured keys", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = harness({ nativeWidgets: true }); await h.start(); h.f8(); await nextTask();
  const before = h.widgetText()!;
  h.setConfig(parseConfig({ keybindings: { "dictation.toggle": "f9", "operation.cancel": "f10" } }));
  await h.command("reload");
  initTheme("light", false); h.setClock(12000); t.mock.timers.tick(1000);
  const after = h.widgetText()!;
  assert.notEqual(after, before);
  assert.equal(after.replace(/\x1b\[[0-9;]*m/g, ""), "● REC 00:12 · oaistt · F8 stop · F12 cancel");
  const indicator = h.ui.theme.fg("error", "● REC 00:12");
  assert.ok(after.startsWith(indicator));
  assert.ok(after.slice(indicator.length).startsWith(h.ui.theme.getFgAnsi("muted")));
  assert.deepEqual(h.widgets.get(WIDGET_KEY), [after]);
  assert.equal(h.signals[0]!.aborted, false); assert.equal(h.counts().captures, 1);
  h.f8(); await nextTask();
  assert.equal(h.controller.phase, "transcribing");
  assert.equal(h.widgetText(), expectedProcessingText(h.ui.theme, "transcribing"));
  assert.doesNotMatch(h.widgetText()!, /REC|stop/);
  h.f12(); await h.controller.settled();
  assert.equal(h.widgets.get(WIDGET_KEY), undefined);
});

const processingCases = [
  { name: "defaults", keys: {}, cancel: "F12", sequence: "\x1b[24~" },
  { name: "rebound", keys: { "operation.cancel": "f11" }, cancel: "F11", sequence: "\x1b[23~" },
  { name: "multiple", keys: { "operation.cancel": ["f12", "shift+f12"] }, cancel: "F12 / Shift+F12", sequence: "\x1b[24~" },
  { name: "unbound", keys: { "operation.cancel": [] }, cancel: "", sequence: "" },
  { name: "native conflict", keys: { "operation.cancel": "f6" }, cancel: "", sequence: "", native: { "app.model.select": "f6" } },
  { name: "own conflict", keys: { "operation.cancel": "f8" }, cancel: "", sequence: "" },
] as const;
const processingModes = [
  { name: "transcription", phase: "transcribing", manual: false },
  { name: "automatic correction", phase: "correcting", manual: false },
  { name: "manual correction", phase: "correcting", manual: true },
] as const;
for (const fullscreen of [false, true]) for (const mode of processingModes) for (const row of processingCases) {
  test(`processing guidance: ${mode.name}/${row.name}/${fullscreen ? "fullscreen" : "regular"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const h = harness({ fullscreen, nativeWidgets: true, streaming: true, bindings: "native" in row ? row.native : undefined });
    h.setConfig(parseConfig({ keybindings: row.keys, correction: { automatic: true } }));
    Object.defineProperty(h.ctx, "model", { get: () => { throw new Error("guidance must not read main identity"); } });
    h.ctx.modelRegistry = { find: () => { throw new Error("guidance must not probe models"); } } as unknown as ModelRegistry;
    const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
    h.footerStatuses.set("other-extension", "OTHER_STATUS");
    await h.start(); h.ui.setEditorText("synthetic draft");
    const footerBefore = plain(h.mode.footerContainer.render(120).join("\n"));
    if (mode.manual) { h.f7(); await nextTask(); }
    else {
      await h.command("dictation start"); await nextTask(); await h.command("dictation stop"); await nextTask();
      if (mode.phase === "correcting") { h.raw.resolve("synthetic dictation"); await nextTask(); }
    }
    assert.equal(h.controller.phase, mode.phase);
    const expected = `oaistt · ${mode.phase}…${row.cancel ? ` · ${row.cancel} cancel` : ""}`;
    const before = h.widgetText()!;
    assert.equal(plain(before), expected);
    assert.equal(before, expectedProcessingText(h.ui.theme, mode.phase, row.cancel));
    assert.ok(before.startsWith(h.ui.theme.getFgAnsi("muted")));
    assert.ok(!before.includes(h.ui.theme.getFgAnsi("error")));
    assert.doesNotMatch(plain(before), /REC|stop|start|unbound|ready/);
    assert.ok(plain(h.mode.widgetContainerAbove.render(120).join("\n")).includes(expected));
    for (const width of [12, 20, 32, 80, 120]) {
      for (const line of h.mode.widgetContainerAbove.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    // Settings-only reload must not advertise a key that is not installed.
    h.setConfig(parseConfig({ keybindings: { "operation.cancel": "f10" } }));
    await h.command("reload"); initTheme("light", false); t.mock.timers.tick(1000);
    assert.equal(plain(h.widgetText()!), expected);
    assert.equal(h.widgetText(), expectedProcessingText(h.ui.theme, mode.phase, row.cancel));
    assert.notEqual(h.widgetText(), before);
    assert.equal(h.signals.at(-1)!.aborted, false);
    if (row.sequence) h.terminal.send(row.sequence);
    else {
      h.f12(); assert.equal(h.signals.at(-1)!.aborted, false);
      await h.command("cancel");
    }
    assert.equal(h.signals.at(-1)!.aborted, true);
    assert.equal(h.widgets.get(WIDGET_KEY), undefined);
    await h.controller.settled();
    h.raw.resolve("synthetic late dictation"); h.edited.resolve({ kind: "corrected", text: "synthetic late correction" });
    await nextTask(); t.mock.timers.tick(1000);
    assert.equal(h.ui.getEditorText(), "synthetic draft");
    assert.equal(h.widgets.get(WIDGET_KEY), undefined);
    assert.deepEqual(h.footerStatuses, new Map([["other-extension", "OTHER_STATUS"]]));
    assert.equal(plain(h.mode.footerContainer.render(120).join("\n")), footerBefore);
    assert.equal(h.main.signal.aborted, false); assert.equal(h.promptCalls.length, 0);
    assert.equal(h.counts().captures, mode.manual ? 0 : 1);
  });
}
