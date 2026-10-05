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
import { loadInstallationIdentity, installationLabel, type InstallationIdentity } from "./version.ts";
import { ACTIONS, DEFAULT_BINDINGS, nativeSafe, type Action, type Bindings } from "./keys.ts";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, ConfigStore, transcriptionKey, type Config } from "./config.ts";
import { correct } from "./correction.ts";
import { installEditorBoundary, type EditorBoundary } from "./editor.ts";
import { DictationError, OperationController, type DeliveryOwner, type Phase, type Pipeline, type OperationKind } from "./operation.ts";
import { recordParecord, listRecordingSources } from "./recorder.ts";
import { transcribe, prepareAudio, transcriptionChain, transcriptionCandidates, TranscriptionFailure } from "./transcription.ts";

export const WIDGET_KEY = "pi-oaistt";
const USAGE = "Defaults: F8 dictation toggle; F7 correct draft; F12 cancel. /oaistt help | status | dictation toggle/start/stop | cancel | recorder sources/source NAME [--save] | transcription list/profile NAME [--save] | reload. Key changes require full Pi /reload.";
const displayKeys = (keys: string[]): string => keys.map(key => key.split("+").map(part =>
  /^f\d+$/u.test(part) || part.length <= 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1),
).join("+")).join(" / ") || "unbound";
function keyHint(ctx: ExtensionContext, bindings: Bindings, action: Action, text: string): string | undefined {
  const keys = bindings[action];
  return keys.length ? `${ctx.ui.theme.style(displayKeys(keys), { fg: "text", bold: true })} ${text}` : undefined;
}
const CONTROL_ORDER: Action[] = ["dictation.toggle", "editor.correct", "operation.cancel", "dictation.start", "dictation.stop"];
const CONTROL_DESCRIPTIONS: Record<Action, string> = {
  "dictation.toggle": "Start or stop dictation", "editor.correct": "Correct the current draft",
  "operation.cancel": "Cancel oaistt", "dictation.start": "Start recording", "dictation.stop": "Stop and transcribe",
};
type Store = Pick<ConfigStore, "load" | "setSource" | "saveSource" | "saveProfile">;
export interface Dependencies {
  identity: () => Promise<InstallationIdentity>;
  store: Store; record: Pipeline["record"]; transcribe: typeof transcribe; correct: typeof correct;
  key: typeof transcriptionKey; prepare: typeof prepareAudio; sources: typeof listRecordingSources; clock: () => number;
}
interface Scope {
  ctx: ExtensionContext; id: string; boundary?: EditorBoundary; feedback?: Feedback; abort: AbortController;
}

type ProcessingPhase = "transcribing" | "correcting";

/** One owner-scoped feedback widget above the editor. */
class Feedback {
  #ctx: ExtensionContext;
  #clock: () => number;
  #current: () => boolean;
  #checkEditor: () => boolean;
  #recordingText: (elapsed: string) => string;
  #processingText: (phase: ProcessingPhase) => string;
  #phase: Phase = "idle";
  #since = 0;
  #lastText?: string;
  #timer?: ReturnType<typeof setInterval>;
  constructor(ctx: ExtensionContext, clock: () => number, current: () => boolean, checkEditor: () => boolean,
    recordingText: (elapsed: string) => string, processingText: (phase: ProcessingPhase) => string) {
    this.#ctx = ctx; this.#clock = clock; this.#current = current; this.#checkEditor = checkEditor;
    this.#recordingText = recordingText; this.#processingText = processingText;
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
      text = this.#recordingText(elapsed);
    } else if (this.#phase === "transcribing" || this.#phase === "correcting") {
      text = this.#processingText(this.#phase);
    } else {
      const label = { starting: "Starting recorder…", stopping: "Stopping…", cleaning: "Cleaning up…", idle: "" }[this.#phase];
      text = this.#ctx.ui.theme.fg("muted", label);
    }
    if (text === this.#lastText) return;
    this.#lastText = text;
    this.#ctx.ui.setWidget(WIDGET_KEY, [text], { placement: "aboveEditor" });
  }
  clear(): void {
    clearInterval(this.#timer); this.#timer = undefined; this.#phase = "idle"; this.#lastText = undefined;
    if (!this.#current()) return;
    this.#ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
}

/** Factory has no processes, timers, config I/O or provider work. */
export function registerDictation(pi: ExtensionAPI, overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { identity: loadInstallationIdentity, store: new ConfigStore(getAgentDir()), record: recordParecord, transcribe, correct,
    key: transcriptionKey, prepare: prepareAudio, sources: listRecordingSources, clock: () => performance.now(), ...overrides };
  const controller = new OperationController(), selection = new ProfileSelection();
  let scope: Scope | undefined, owner: DeliveryOwner | undefined;
  let initialized = false, keysInstalled = false, changing = 0, reloading = 0, epoch = 0, configError: string | undefined;
  let activeBindings: Bindings = structuredClone(DEFAULT_BINDINGS);
  for (const action of ACTIONS) activeBindings[action] = [];
  let identity: InstallationIdentity = {}, identityReady: Promise<void> | undefined;
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
  function startupText(ctx: ExtensionContext): string {
    const hint = (action: Action, text: string) => keyHint(ctx, activeBindings, action, text);
    const dictation = activeBindings["dictation.toggle"].length ? [hint("dictation.toggle", "to dictate")]
      : activeBindings["dictation.start"].length && activeBindings["dictation.stop"].length
        ? [hint("dictation.start", "to start dictation"), hint("dictation.stop", "to stop dictation")] : [];
    return [
      `${ctx.ui.theme.style("oaistt", { fg: "text", bold: true })} — speech to text`,
      ...dictation, hint("editor.correct", "to correct"), hint("operation.cancel", "to cancel"), "see /oaistt help",
    ].filter(Boolean).join(" · ");
  }
  function recordingText(ctx: ExtensionContext, elapsed: string): string {
    // Recording is already active: a stop binding alone suffices, unlike startup.
    const stop: Action = activeBindings["dictation.toggle"].length ? "dictation.toggle" : "dictation.stop";
    const hints = [ctx.ui.theme.style("oaistt", { fg: "text", bold: true }),
      keyHint(ctx, activeBindings, stop, "stop"), keyHint(ctx, activeBindings, "operation.cancel", "cancel")];
    return ctx.ui.theme.fg("error", `● REC ${elapsed}`)
      + ctx.ui.theme.fg("muted", ` · ${hints.filter(Boolean).join(" · ")}`);
  }
  function processingText(ctx: ExtensionContext, phase: ProcessingPhase): string {
    return ctx.ui.theme.fg("muted", [
      ctx.ui.theme.style("oaistt", { fg: "text", bold: true }), `${phase}…`,
      keyHint(ctx, activeBindings, "operation.cancel", "cancel"),
    ].filter(Boolean).join(" · "));
  }
  pi.on("session_start", async (_event, ctx) => {
    if (scope) await teardown("session changed");
    if (ctx.mode !== "tui") return;
    const current: Scope = { ctx, id: ctx.sessionManager.getSessionId(), abort: new AbortController() };
    scope = current;
    try { current.boundary = installEditorBoundary(pi, ctx, () => controller.cancel("submitted"), () => controller.contentChanged()); }
    catch { error(ctx, "pi-oaistt requires the stock Pi editor; another editor is installed."); }
    identityReady ??= Promise.resolve().then(() => deps.identity()).then(value => { identity = value; }).catch(() => {});
    if (!initialized) { initialized = true; await load(ctx); }
    await identityReady;
    if (!live(current)) return;
    installKeys(current);
    if (current.boundary?.isInstalled() && selection.config) notice(ctx, startupText(ctx));
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
    }, elapsed => recordingText(ctx, elapsed), phase => processingText(ctx, phase));
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
  function statusText(ctx: ExtensionContext): string {
    const config = selection.config;
    const strong = (text: string) => ctx.ui.theme.style(text, { fg: "text", bold: true });
    const candidates = (values: string[], empty: string): string[] => values.length
      ? values.map((value, index) => `    • ${index === 0 ? strong(value) : value}`) : [`    ${empty}`];
    const keys = (bindings: Bindings): string[] => CONTROL_ORDER.map(action => {
      const label = displayKeys(bindings[action]);
      return `  • ${bindings[action].length ? strong(label) : label} — ${CONTROL_DESCRIPTIONS[action]}`;
    });
    // Preview next-operation candidates, not live attempts or proven availability.
    // Share following-only STT order with dispatch; $current alone authorizes identity access.
    const profiles = config && selection.selected ? transcriptionCandidates(config, selection.selected).map(safeLabel) : [];
    const model = config?.correction.order.includes("$current") ? ctx.model : undefined;
    const models = config?.correction.order.map(selector => selector === "$current"
      ? `$current (${model ? safeLabel(`${model.provider}/${model.id}`) : "unavailable"})` : safeLabel(selector)) ?? [];
    const activeSource = controller.captureSource;
    const source = activeSource === undefined ? config?.recorder.source : activeSource;
    const lines = [
      `${strong(`${installationLabel(identity)}:`)} ${controller.phase}${controller.kind ? ` (${controller.kind})` : ""}. Configuration ${config ? "loaded successfully" : "unavailable"}.`, "",
      strong("Transcription:"),
      `  Active:   ${activeProfile ? safeLabel(activeProfile) : "none"}`,
      `  Default:  ${config ? safeLabel(config.transcription.order[0]!) : "unavailable"}`,
      `  Fallback: ${config ? config.transcription.automaticFallback ? "on" : "off" : "unavailable"}`,
      "  Profiles, in order:", ...candidates(profiles, "unavailable"), "",
      strong("Correction:"),
      `  Automatic: ${config ? config.correction.automatic ? "on" : "off" : "unavailable"}`,
      "  Models, in order:", ...candidates(models, config ? "none (no requests)" : "unavailable"), "",
      strong("Capture device:"),
      `  ${source === undefined ? "unavailable" : source === null ? "server default source" : safeLabel(source)}`, "",
      strong("Active keys:"), ...keys(activeBindings),
    ];
    if (config && JSON.stringify(config.keybindings) !== JSON.stringify(registeredBindings)) lines.push(
      "", strong("Configured/pending keys:"), ...keys(config.keybindings),
      "Full Pi /reload required; native conflicts may disable bindings. Cross-extension conflicts follow Pi priority.",
    );
    lines.push("", `See ${strong("/oaistt help")} for commands and controls.`);
    return lines.join("\n");
  }
  function status(ctx: ExtensionContext, lead?: string): void {
    notice(ctx, [lead, statusText(ctx)].filter(Boolean).join("\n"));
  }
  function commandHelp(ctx: ExtensionContext): string {
    const strong = (text: string) => ctx.ui.theme.style(text, { fg: "text", bold: true });
    const command = (syntax: string, description?: string) => `  ${strong(syntax)}${description
      ? `${" ".repeat(Math.max(2, 43 - syntax.length))}${description}` : ""}`;
    const controls = ACTIONS.filter(action => DEFAULT_BINDINGS[action].length || activeBindings[action].length).map(action => {
      const keys = displayKeys(activeBindings[action]);
      const defaults = JSON.stringify(activeBindings[action]) === JSON.stringify(DEFAULT_BINDINGS[action])
        ? "" : ` (default: ${displayKeys(DEFAULT_BINDINGS[action])})`;
      return `  ${strong(keys)}${" ".repeat(Math.max(2, 7 - keys.length))}${CONTROL_DESCRIPTIONS[action]}${defaults}`;
    });
    const config = selection.config, first = config?.correction.order[0];
    // The compact preview names only the first configured selector, not a proven
    // usable model. Separate status retains the complete next-operation order.
    const model = first === "$current" ? ctx.model : undefined;
    const correction = !config ? "Draft correction: configuration unavailable." : !first
      ? "Draft correction needs a correction model; none is configured."
      : `Correction model: ${first === "$current" ? model ? safeLabel(`${model.provider}/${model.id}`)
        : "$current (unavailable)" : safeLabel(first)}`;
    return [
      strong("oaistt — speech to text and draft correction"), "",
      "Dictate into Pi’s prompt draft, or correct text already there.",
      "Review the result before sending; oaistt never submits a prompt on its own.", "",
      strong("Controls:"), ...controls, "", `  ${correction}`, "",
      "Abbreviations appear in parentheses: (d t) means /oaistt d t.", "",
      strong("Dictation:"),
      command("/oaistt dictation toggle (d t)", "Start, or stop and transcribe"),
      command("/oaistt dictation start (d start)", "Start recording"),
      command("/oaistt dictation stop (d stop)", "Stop and transcribe"),
      command("/oaistt cancel (x)", "Cancel oaistt"), "",
      strong("Transcription:"), "  Choose which configured service transcribes your speech.", "",
      command("/oaistt transcription list (t l)", "Show profiles and fallback policy"),
      command("/oaistt transcription profile NAME [--save] (t p)"),
      "    Select a profile for subsequent dictation.", "",
      strong("Capture device:"), "  Choose the microphone or other recording input.", "",
      command("/oaistt recorder sources (r l)", "List available inputs"),
      command("/oaistt recorder source NAME [--save] (r s)"),
      "    Select an input. Use NAME “default” to follow the server default.", "",
      strong("Settings and help:"),
      command("/oaistt", "Show current state and selections"),
      command("/oaistt status (s)", "Show current state and selections"),
      command("/oaistt help (h)", "Show this help"),
      command("/oaistt reload (rl)", "Reload settings for subsequent work"), "",
      strong("Notes:"),
      // One logical line per note; Pi wraps at the available notice width.
      "  Without NAME, source/profile commands report selection/usage without changing it.",
      "  Device/profile selections are temporary; add --save to keep the choice in configuration. Host audio settings stay unchanged.", "",
      "  Settings reload leaves active dictation/correction unchanged.",
      "  Key or extension-code changes require Pi /reload, which cancels dictation or correction in progress.",
    ].join("\n");
  }
  function help(ctx: ExtensionContext): void {
    // One help-only notice: expanded status must not scroll commands out of view.
    notice(ctx, commandHelp(ctx));
  }
  async function command(args: string, ctx: ExtensionContext): Promise<void> {
    const current = validScope(ctx); if (!current) return;
    const p = args.trim().split(/\s+/u).filter(Boolean);
    const exact: Record<string, string> = { "": "status", h: "help", s: "status", x: "cancel", rl: "reload", "d t": "dictation toggle", "d start": "dictation start", "d stop": "dictation stop", "r l": "recorder sources", "t l": "transcription list" };
    const action = exact[p.join(" ")] ?? p.join(" ");
    if (action === "help") { help(ctx); return; }
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
    const group = (p[0] === "recorder" && p[1] === "source" || p[0] === "r" && p[1] === "s") ? "recorder"
      : (p[0] === "transcription" && p[1] === "profile" || p[0] === "t" && p[1] === "p") ? "transcription" : undefined;
    if (!["recorder", "transcription"].includes(group ?? "") || p.length > 4 || p.length === 4 && p[3] !== "--save" || p[2] === "--save") { error(ctx, USAGE); return; }
    if (p.length === 2) {
      notice(ctx, group === "recorder" ? `Recording source: ${selection.config?.recorder.source ? safeLabel(selection.config.recorder.source) : "server default"}. Use recorder source NAME [--save].` : `Next transcription profile: ${selection.selected ?? "unavailable"}. Use transcription profile NAME [--save].`); return;
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
