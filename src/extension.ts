/**
 * pi-oaistt interactive extension
 *
 * Purpose: coordinate dictation controls, session ownership and visible phase feedback.
 * Strategy: delegate bounded work and retain public editor, lifecycle and UI seams.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { Type } from "@earendil-works/pi-ai";
import { ProfileSelection, safeLabel } from "./profiles.ts";
import { ACTIONS, DEFAULT_BINDINGS, nativeSafe, type Action, type Bindings } from "./keys.ts";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, ConfigStore, transcriptionKey, type Config } from "./config.ts";
import { correct } from "./correction.ts";
import { installEditorBoundary, type EditorBoundary } from "./editor.ts";
import { DictationError, OperationController, type DeliveryOwner, type Phase, type Pipeline, type OperationKind } from "./operation.ts";
import { recordParecord, listRecordingSources } from "./recorder.ts";
import { transcribe, prepareAudio, transcriptionChain, TranscriptionFailure } from "./transcription.ts";

export const STATUS_KEY = "footer-compositor:right:80:pi-oaistt";
export const WIDGET_KEY = "pi-oaistt";
const USAGE = "Defaults: F8 dictation toggle; F7 correct draft; F12 cancel. /oaistt help | status | dictation toggle/start/stop | cancel | recorder sources/source NAME [--save] | transcription list/source NAME [--save] | reload. Key changes require full Pi /reload.";
const COMMAND_HELP = [
  "oaistt command help (short forms also follow /oaistt)",
  "  /oaistt                              Concise help and status",
  "  /oaistt help (h)                     Commands, controls and status",
  "  /oaistt status (s)                   Operation and next selections",
  "  /oaistt dictation toggle (d t)       Start, or stop/use recording",
  "  /oaistt dictation start (d start)    Start only if oaistt is idle",
  "  /oaistt dictation stop (d stop)      Gracefully stop/use recording",
  "  /oaistt cancel (x)                   Cancel oaistt, not the main agent",
  "  /oaistt recorder sources (r l)       List recording sources; no capture",
  "  /oaistt recorder source NAME [--save] (r s)",
  "    Select an input for next recording; default follows server default",
  "  /oaistt transcription list (t l)     List configured profiles/policy",
  "  /oaistt transcription source NAME [--save] (t s)",
  "    Select an active profile for next recording; --save promotes its order",
  "  /oaistt reload (rl)                  Reload pipeline settings for next work",
  "",
  "Without NAME, source commands report selection/usage; they do not change it.",
  "Selections are temporary unless --save is given; host audio settings stay unchanged.",
  "Draft correction (default F7) needs configured correction models, not audio.",
  "Never submits a prompt. Escape remains Pi's control; use /oaistt cancel for this operation.",
  "Key/code changes need full Pi /reload (cancels active work). Settings-only reload does not.",
].join("\n");
type Store = Pick<ConfigStore, "load" | "setSource" | "saveSource" | "saveProfile">;
export interface Dependencies {
  store: Store; record: Pipeline["record"]; transcribe: typeof transcribe; correct: typeof correct;
  key: typeof transcriptionKey; prepare: typeof prepareAudio; sources: typeof listRecordingSources; clock: () => number;
}
interface Scope {
  ctx: ExtensionContext; id: string; boundary?: EditorBoundary; feedback?: Feedback; abort: AbortController;
}

/** One short public widget also covers footers that ignore extension statuses. */
class Feedback {
  #ctx: ExtensionContext;
  #clock: () => number;
  #current: () => boolean;
  #checkEditor: () => boolean;
  #phase: Phase = "idle";
  #since = 0;
  #lastText?: string;
  #timer?: ReturnType<typeof setInterval>;
  constructor(ctx: ExtensionContext, clock: () => number, current: () => boolean, checkEditor: () => boolean) {
    this.#ctx = ctx; this.#clock = clock; this.#current = current; this.#checkEditor = checkEditor;
  }
  phase(phase: Phase): void {
    clearInterval(this.#timer); this.#timer = undefined;
    this.#phase = phase;
    if (phase === "idle") { this.clear(); return; }
    if (phase === "recording") this.#since = this.#clock();
    this.#render();
    this.#timer = setInterval(() => {
      if (!this.#current()) { clearInterval(this.#timer); this.#timer = undefined; return; }
      if (!this.#checkEditor()) return;
      this.#render(); // Re-evaluate the active theme even during static phases.
    }, 1000);
  }
  #render(): void {
    if (!this.#current()) return;
    let text: string;
    if (this.#phase === "recording") {
      const seconds = Math.max(0, Math.floor((this.#clock() - this.#since) / 1000));
      const elapsed = `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
      text = this.#ctx.ui.theme.fg("error", `● REC ${elapsed}`);
    } else {
      const label = { starting: "Starting recorder…", stopping: "Stopping…", transcribing: "Transcribing…",
        correcting: "Correcting…", cleaning: "Cleaning up…", idle: "" }[this.#phase];
      text = this.#ctx.ui.theme.fg("muted", label);
    }
    if (text === this.#lastText) return;
    this.#lastText = text;
    this.#ctx.ui.setStatus(STATUS_KEY, text);
    this.#ctx.ui.setWidget(WIDGET_KEY, [text], { placement: "aboveEditor" });
  }
  clear(): void {
    clearInterval(this.#timer); this.#timer = undefined; this.#phase = "idle"; this.#lastText = undefined;
    if (!this.#current()) return;
    this.#ctx.ui.setStatus(STATUS_KEY, undefined);
    this.#ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
}

/** Factory has no processes, timers, config I/O or provider work. */
export function registerDictation(pi: ExtensionAPI, overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { store: new ConfigStore(getAgentDir()), record: recordParecord, transcribe, correct,
    key: transcriptionKey, prepare: prepareAudio, sources: listRecordingSources, clock: () => performance.now(), ...overrides };
  const controller = new OperationController(), selection = new ProfileSelection();
  let scope: Scope | undefined, owner: DeliveryOwner | undefined;
  let initialized = false, keysInstalled = false, changing = 0, reloading = 0, epoch = 0, configError: string | undefined;
  let activeBindings: Bindings = structuredClone(DEFAULT_BINDINGS);
  for (const action of ACTIONS) activeBindings[action] = [];
  let activeProfile: string | undefined;
  let registeredBindings: Bindings | undefined;
  const live = (candidate: Scope): boolean => {
    if (scope !== candidate) return false;
    try { return candidate.ctx.sessionManager.getSessionId() === candidate.id; } catch { return false; }
  };
  const notice = (ctx: ExtensionContext, message: string) => {
    if (ctx.hasUI) ctx.ui.notify(ctx.ui.theme.fg("muted", message), "info");
  };
  const error = (ctx: ExtensionContext, message: string) => { if (ctx.hasUI) ctx.ui.notify(message, "error"); };
  const configFailure = (cause: unknown) => cause instanceof ConfigError ? cause.message : "Cannot load oaistt configuration.";
  const validScope = (ctx: ExtensionContext): Scope | undefined => {
    if (ctx.mode !== "tui") { notice(ctx, "pi-oaistt requires interactive terminal mode; no recorder or editor correction started."); return; }
    if (!scope || !live(scope)) { notice(ctx, "oaistt is not ready in this session."); return; }
    return scope;
  };
  async function load(ctx: ExtensionContext): Promise<void> {
    const candidate = scope;
    const request = ++epoch; selection.invalidate(); changing++; reloading++;
    try {
      const config = await deps.store.load();
      if (request !== epoch) return;
      selection.reset(config); configError = undefined;
      if (candidate && live(candidate)) for (const message of config.keyErrors) error(ctx, message);
    } catch (cause) {
      if (request !== epoch) return;
      selection.reset(); configError = configFailure(cause); if (candidate && live(candidate)) error(ctx, configError);
    } finally { changing--; reloading--; }
  }
  async function teardown(reason: "shutdown" | "session changed"): Promise<void> {
    const old = scope; controller.cancel(reason); old?.feedback?.clear(); old?.abort.abort();
    await controller.settled();
    if (old && live(old)) {
      if (controller.active) notice(old.ctx, "Recorder cleanup failed; check owned recorder before restarting.");
      old.boundary?.dispose();
    }
    if (scope === old) { scope = undefined; owner = undefined; activeProfile = undefined; }
  }
  function installKeys(current: Scope): void {
    if (keysInstalled) return;
    keysInstalled = true;
    current.boundary?.refreshNativeBindings();
    const config = selection.config;
    if (!config) { error(current.ctx, "Configuration unavailable; fix settings then full Pi /reload for shortcut bindings."); return; }
    registeredBindings = structuredClone(config.keybindings);
    const resolved = nativeSafe(config.keybindings, current.boundary?.nativeBindings() ?? {});
    activeBindings = resolved.bindings;
    for (const message of resolved.errors) error(current.ctx, message);
    for (const action of ACTIONS) for (const key of activeBindings[action]) {
      pi.registerShortcut(key as Parameters<ExtensionAPI["registerShortcut"]>[0], {
        description: `oaistt ${action} (never submits)`, handler: ctx => {
          // A cached old native dispatcher cannot resurrect an invalid scope.
          if (scope && live(scope)) dispatch(action, ctx);
        },
      });
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    if (scope) await teardown("session changed");
    if (ctx.mode !== "tui") return;
    const current: Scope = { ctx, id: ctx.sessionManager.getSessionId(), abort: new AbortController() };
    scope = current;
    try { current.boundary = installEditorBoundary(pi, ctx, () => controller.cancel("submitted"), () => controller.contentChanged()); }
    catch { error(ctx, "pi-oaistt requires the stock Pi editor; another editor is installed."); }
    if (!initialized) { initialized = true; await load(ctx); }
    if (!live(current)) return;
    installKeys(current);
    if (current.boundary?.isInstalled() && selection.config) notice(ctx, "pi-oaistt ready. Defaults: F8 dictation, F7 draft correction, F12 cancel; /oaistt help lists active controls.");
  });
  const navigation = () => { controller.cancel("session changed"); };
  pi.on("session_before_switch", navigation); pi.on("session_before_fork", navigation);
  pi.on("session_before_tree", navigation); pi.on("session_tree", navigation);
  pi.on("session_shutdown", event => teardown(event.reason === "quit" || event.reason === "reload" ? "shutdown" : "session changed"));

  function dispatch(action: Action, ctx: ExtensionContext): void {
    const current = validScope(ctx); if (!current) return;
    if (action === "operation.cancel") { controller.cancel(); return; }
    if (controller.active) {
      if (action === "dictation.stop" || action === "dictation.toggle" && controller.phase === "recording") controller.stop();
      else notice(ctx, `oaistt is ${controller.phase}.`);
      return;
    }
    if (action === "dictation.stop") { notice(ctx, "No recording is active."); return; }
    if (!current.boundary?.isInstalled()) { error(ctx, "oaistt requires its stock-editor adapter; restore stock editor and /reload."); return; }
    if (changing) { notice(ctx, "oaistt configuration is loading; retry shortly."); return; }
    const config = selection.config;
    if (!config) { error(ctx, configError ?? "oaistt configuration unavailable."); return; }
    const manual = action === "editor.correct";
    if (manual && !ctx.ui.getEditorText().trim()) { notice(ctx, "Nothing to correct."); return; }
    const token = selection.snapshot();
    // Read the main identity ONLY for an explicitly listed selector. Never its
    // thinking level, settings, prompt or implicit fallback/authentication.
    const selectedModel = config.correction.order.includes("$current") ? ctx.model : undefined;
    const currentModel = selectedModel && { provider: selectedModel.provider, id: selectedModel.id };
    let resultFinished = false, lostEditorNotice = false;
    const delivery: DeliveryOwner = {
      ui: ctx.ui, revision: () => current.boundary!.revision(),
      isCurrent: () => live(current) && owner === delivery && current.boundary!.isInstalled(),
      phase: phase => { if (phase === "idle") resultFinished = true; feedback.phase(phase); },
      notice: text => { if (live(current) && owner === delivery) notice(ctx, text); },
      error: text => { if (live(current) && owner === delivery) error(ctx, text); },
    };
    owner = delivery; activeProfile = manual ? undefined : token.selected;
    const feedback = new Feedback(ctx, deps.clock, () => live(current) && owner === delivery, () => {
      if (current.boundary!.isInstalled()) return true;
      controller.cancel("editor changed"); feedback.clear();
      if (!resultFinished && !lostEditorNotice) { lostEditorNotice = true; notice(ctx, `${manual ? "Draft correction" : "Dictation"} discarded: editor changed.`); }
      return false;
    });
    current.feedback = feedback;
    const stillOwned = () => {
      if (delivery.isCurrent()) return true;
      if (owner === delivery) controller.cancel("editor changed");
      return false;
    };
    const warning = (phase: string, signal: AbortSignal, failed: string, reason: string, next: string) => {
      if (!signal.aborted && delivery.isCurrent()) ctx.ui.notify(`${phase}: ${safeLabel(failed)} failed: ${reason}; trying ${safeLabel(next)}.`, "warning");
    };
    const pipeline: Pipeline = {
      record: deps.record,
      transcribe: async (audio, frozen, signal) => {
        const deadline = performance.now() + frozen.transcription.totalTimeoutSeconds * 1000;
        const bytes = await deps.prepare(audio, frozen); signal.throwIfAborted();
        const result = await transcriptionChain(frozen, token.selected, signal, async (profile, attemptSignal) => {
          let key: string | undefined;
          try { key = deps.key(profile); } catch { throw new TranscriptionFailure("credentials unavailable"); }
          return deps.transcribe(audio, frozen, attemptSignal, key, undefined, profile, bytes);
        }, (failed, reason, next) => warning("Transcription", signal, failed, reason, next), deadline, stillOwned);
        signal.throwIfAborted();
        if (delivery.isCurrent()) { selection.publish(token, result.profile); activeProfile = result.profile; }
        return result.text;
      },
      correct: (target, frozen, signal, kind) => deps.correct(target, frozen, signal, ctx.sessionManager, ctx.modelRegistry, {
        manual: kind === "manual", current: currentModel, isCurrent: stillOwned,
        warning: (failed, reason, next) => warning("Correction", signal, failed, reason, next),
      }),
    };
    if (manual) controller.correctDraft(config, delivery, pipeline);
    else controller.start(config, delivery, pipeline);
    void controller.settled().then(() => {
      if (!live(current) || owner !== delivery) return;
      feedback.clear();
      if (!resultFinished && !current.boundary!.isInstalled() && !lostEditorNotice) notice(ctx, "oaistt discarded: editor changed.");
      if (!controller.active) { owner = undefined; activeProfile = undefined; }
    });
  }

  async function select(name: string, save: boolean): Promise<void> {
    if (reloading) throw new ConfigError("oaistt configuration is loading; retry shortly.");
    selection.select(name); // Includes same-name intent before any awaited save.
    if (!save) return;
    const request = ++epoch; selection.invalidate(); changing++;
    try {
      await deps.store.saveProfile(name);
      const config = await deps.store.load();
      if (request === epoch) selection.saved(config, selection.generation);
    } finally { changing--; }
  }
  const bindingsLabel = (bindings: Bindings) => ACTIONS.map(a => `${a}=${bindings[a].join(",") || "unbound"}`).join("; ");
  function statusText(ctx: ExtensionContext): string {
    const config = selection.config;
    const label = (key: string) => ctx.ui.theme.style(`${key}:`, { fg: "accent", bold: true });
    const row = (key: string, value: string) => `${label(key)}${" ".repeat(Math.max(1, 15 - key.length - 1))}${value}`;
    // Preview next-operation policy, not the active attempt or proven availability.
    // Only inspect the main identity when explicitly authorized by $current.
    const fallback = config ? config.transcription.automaticFallback ? "on" : "off" : "unavailable";
    const model = config?.correction.order.includes("$current") ? ctx.model : undefined;
    const models = config?.correction.order.map(selector => selector === "$current"
      ? `$current (${model ? safeLabel(`${model.provider}/${model.id}`) : "unavailable"})`
      : safeLabel(selector)).join(" → ") || "none (no requests)";
    const lines = [
      `${label("oaistt")} ${controller.phase}${controller.kind ? ` (${controller.kind})` : ""}. ${label("Config")} ${config ? "ready" : "unavailable"}.`,
      "",
      row("Transcription", `active: ${activeProfile ?? "none"}; next: ${selection.selected ?? "unavailable"}; default: ${config?.transcription.order[0] ?? "unavailable"}; fallback: ${fallback}.`),
      row("Correction", config ? `automatic ${config.correction.automatic ? "on" : "off"}; next order: ${models}.` : "unavailable."),
      row("Recorder", config ? `next capture: ${config.recorder.source ? "configured source override" : "server default source"}.` : "unavailable."),
      row("Active keys", `${bindingsLabel(activeBindings)}.`),
    ];
    if (config && JSON.stringify(config.keybindings) !== JSON.stringify(registeredBindings)) lines.push(
      row("Configured/pending keys", `${bindingsLabel(config.keybindings)}.`),
      "Full Pi /reload required; native conflicts may disable bindings. Cross-extension conflicts follow Pi priority.",
    );
    return lines.join("\n");
  }
  function status(ctx: ExtensionContext, lead?: string): void {
    notice(ctx, [lead, statusText(ctx)].filter(Boolean).join("\n"));
  }
  function help(ctx: ExtensionContext, concise: boolean): void {
    const controls = ["Controls (Defaults / Active keys):", ...ACTIONS.map(action =>
      `  ${action}: default: ${DEFAULT_BINDINGS[action].join(",") || "unbound"}; active: ${activeBindings[action].join(",") || "unbound"}`,
    )].join("\n");
    const summary = "Defaults: F8 dictation; F7 correct draft; F12 cancel (never submits). /oaistt help lists commands and controls.";
    // Pi coalesces consecutive info notices. Send help and state atomically so
    // the final status/pending-key notice cannot replace the command help.
    notice(ctx, [concise ? summary : `${COMMAND_HELP}\n\n${controls}`, statusText(ctx)].join("\n\n"));
  }
  async function command(args: string, ctx: ExtensionContext): Promise<void> {
    const current = validScope(ctx); if (!current) return;
    const p = args.trim().split(/\s+/u).filter(Boolean);
    const exact: Record<string, string> = { "": "help", h: "help", s: "status", x: "cancel", rl: "reload", "d t": "dictation toggle", "d start": "dictation start", "d stop": "dictation stop", "r l": "recorder sources", "t l": "transcription list" };
    const action = exact[p.join(" ")] ?? p.join(" ");
    if (action === "help") { help(ctx, p.length === 0); return; }
    if (action === "status") { status(ctx); return; }
    if (action === "cancel") { controller.cancel(); return; }
    if (["dictation toggle", "dictation start", "dictation stop"].includes(action)) {
      dispatch(action.replace(" ", ".") as Action, ctx); return;
    }
    if (action === "reload") {
      await load(ctx);
      if (live(current) && selection.config) status(ctx, "oaistt settings reloaded; active operation keeps frozen settings.");
      return;
    }
    if (action === "transcription list") { notice(ctx, JSON.stringify(selection.metadata(activeProfile))); return; }
    if (action === "recorder sources") {
      try { const sources = await deps.sources(current.abort.signal); if (live(current)) notice(ctx, JSON.stringify(sources)); }
      catch (failure) {
        if (live(current) && !current.abort.signal.aborted) error(ctx, failure instanceof DictationError
          ? failure.message : "Cannot list recording sources; check Pulse server access.");
      }
      return;
    }
    const group = p[0] === "r" && p[1] === "s" ? "recorder" : p[0] === "t" && p[1] === "s" ? "transcription" : p[1] === "source" ? p[0] : undefined;
    if (!["recorder", "transcription"].includes(group ?? "") || p.length > 4 || p.length === 4 && p[3] !== "--save" || p[2] === "--save") { error(ctx, USAGE); return; }
    if (p.length === 2) {
      notice(ctx, group === "recorder" ? `Recording source: ${selection.config?.recorder.source ? safeLabel(selection.config.recorder.source) : "server default"}. Use recorder source NAME [--save].` : `Next transcription profile: ${selection.selected ?? "unavailable"}. Use transcription source NAME [--save].`); return;
    }
    if (p.length < 3) { error(ctx, USAGE); return; }
    const save = p[3] === "--save";
    try {
      if (group === "transcription") {
        await select(p[2]!, save);
        if (live(current)) notice(ctx, `Transcription profile ${safeLabel(p[2]!)} ${save ? "saved order" : "selected temporarily"}; next: ${selection.selected ?? "unavailable"}. Active operation unchanged.`);
      } else {
        if (reloading || !selection.config) throw new ConfigError("oaistt configuration unavailable/loading.");
        const request = ++epoch; selection.invalidate();
        deps.store.setSource(p[2] === "default" ? null : p[2]!); changing++;
        try {
          if (save) await deps.store.saveSource();
          const config = await deps.store.load();
          if (request === epoch) selection.saved(config, selection.generation);
        } finally { changing--; }
        if (live(current)) notice(ctx, `Recording source ${save ? "saved" : "changed temporarily"}; host routing unchanged.`);
      }
    } catch (cause) { if (live(current)) error(ctx, configFailure(cause)); }
  }
  pi.registerCommand("oaistt", { description: "Dictation/draft controls, help/status, profiles, recorder and settings reload", handler: command });
  async function ensureProfiles(ctx: ExtensionContext): Promise<void> {
    if (!initialized) { initialized = true; await load(ctx); }
    if (!selection.config || reloading) throw new ConfigError(configError ?? "oaistt configuration is loading/unavailable.");
  }
  pi.registerTool({
    name: "oaistt_profiles", label: "oaistt profiles", description: "List bounded active/inactive STT names/model labels and selection/fallback policy. Never reads the editor, credentials or audio, probes providers or controls recording.",
    parameters: Type.Object({}, { additionalProperties: false }), annotations: { readOnlyHint: true, openWorldHint: false },
    execute: async (_id, _params, _signal, _update, ctx) => {
      await ensureProfiles(ctx);
      return { content: [{ type: "text", text: JSON.stringify(selection.metadata(activeProfile)) }], details: undefined };
    },
  });
  pi.registerTool({
    name: "oaistt_select_profile", label: "oaistt select profile",
    description: "Only on explicit user intent, select a configured active STT profile for future dictation. save defaults false; true explicitly promotes saved order. No recording, upload, draft access, main-agent control or host audio change. Subject to normal harness permissions.",
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), save: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    execute: async (_id, params, _signal, _update, ctx) => {
      await ensureProfiles(ctx);
      await select(params.name, params.save ?? false);
      return { content: [{ type: "text", text: JSON.stringify({ requested: params.name, selected: selection.selected, saved: params.save ?? false, default: selection.config?.transcription.order[0] ?? null }) }], details: undefined };
    },
  });
  return { controller, selection };
}
export default function oaistt(pi: ExtensionAPI): void { registerDictation(pi); }
