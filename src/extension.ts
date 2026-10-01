/**
 * pi-oaistt interactive extension
 *
 * Purpose: coordinate dictation controls, session ownership and visible phase feedback.
 * Strategy: delegate bounded work and retain public editor, lifecycle and UI seams.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.1.0
 * Date: 2026-10-01
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigError, ConfigStore, parseConfig, transcriptionKey, type Config } from "./config.ts";
import { correct } from "./correction.ts";
import { installEditorBoundary, type EditorBoundary } from "./editor.ts";
import { OperationController, type DeliveryOwner, type Phase, type Pipeline } from "./operation.ts";
import { recordParecord } from "./recorder.ts";
import { transcribe } from "./transcription.ts";

export const STATUS_KEY = "footer-compositor:right:80:pi-oaistt";
export const WIDGET_KEY = "pi-oaistt";
const USAGE = "F8 or /oaistt: start/stop. /oaistt cancel | status | reload | source <name|default> [--save]";
const routeLabel = (config: Config) => config.transcription.endpoint === "https://api.openai.com/v1/audio/transcriptions"
  ? "OpenAI transcription" : "configured transcription endpoint";
type Store = Pick<ConfigStore, "load" | "setSource" | "saveSource">;
export interface Dependencies {
  store: Store;
  record: Pipeline["record"];
  transcribe: typeof transcribe;
  correct: typeof correct;
  key: typeof transcriptionKey;
  clock: () => number;
}
interface Scope {
  ctx: ExtensionContext;
  id: string;
  boundary?: EditorBoundary;
  config?: Config;
  configError?: string;
  changing: boolean;
  feedback?: Feedback;
  dialogAbort: AbortController;
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
  const deps: Dependencies = {
    store: new ConfigStore(getAgentDir()), record: recordParecord, transcribe, correct,
    key: transcriptionKey, clock: () => performance.now(), ...overrides,
  };
  const controller = new OperationController();
  let scope: Scope | undefined;
  let owner: DeliveryOwner | undefined;
  const live = (candidate: Scope): boolean => {
    if (scope !== candidate) return false;
    try { return candidate.ctx.sessionManager.getSessionId() === candidate.id; } catch { return false; }
  };
  const notice = (ctx: ExtensionContext, message: string) => {
    if (ctx.hasUI) ctx.ui.notify(ctx.ui.theme.fg("muted", message), "info");
  };
  const configFailure = (error: unknown) => error instanceof ConfigError ? error.message : "Cannot load dictation configuration.";

  async function load(candidate: Scope, report = true): Promise<void> {
    candidate.changing = true;
    try {
      const config = await deps.store.load();
      if (live(candidate)) { candidate.config = config; candidate.configError = undefined; }
    } catch (error) {
      if (live(candidate)) {
        candidate.config = undefined; candidate.configError = configFailure(error);
        if (report) notice(candidate.ctx, candidate.configError);
      }
    } finally { candidate.changing = false; }
  }
  async function teardown(reason: "shutdown" | "session changed"): Promise<void> {
    const old = scope;
    controller.cancel(reason); // invalidate BEFORE the first await
    old?.feedback?.clear();
    old?.dialogAbort.abort();
    await controller.settled();
    if (old && live(old)) {
      if (controller.active) notice(old.ctx, "Dictation cleanup failed; check owned recorder before restarting.");
      old.boundary?.dispose();
    }
    if (scope === old) { scope = undefined; owner = undefined; }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (scope) await teardown("session changed");
    if (ctx.mode !== "tui") return;
    const current: Scope = { ctx, id: ctx.sessionManager.getSessionId(), changing: false, dialogAbort: new AbortController() };
    scope = current;
    try { current.boundary = installEditorBoundary(pi, ctx, () => controller.cancel("submitted")); }
    catch { notice(ctx, "pi-oaistt requires the stock Pi editor; another editor is installed."); }
    await load(current);
    if (live(current) && current.boundary?.isInstalled() && current.config) {
      notice(ctx, `pi-oaistt ready (${routeLabel(current.config)}). F8 or /oaistt starts/stops; /oaistt help lists controls.`);
    }
  });
  // Navigation requests conservatively cancel even if another extension vetoes
  // them later. Do not cancel for compaction, model/tool activity or raw Enter.
  pi.on("session_before_switch", () => { controller.cancel("session changed"); });
  pi.on("session_before_fork", () => { controller.cancel("session changed"); });
  pi.on("session_before_tree", () => { controller.cancel("session changed"); });
  pi.on("session_tree", () => { controller.cancel("session changed"); });
  pi.on("session_shutdown", (event) => teardown(
    event.reason === "quit" || event.reason === "reload" ? "shutdown" : "session changed",
  ));

  function toggle(ctx: ExtensionContext): void {
    const current = scope;
    if (!current || !live(current)) { notice(ctx, "Dictation is not ready in this session."); return; }
    const commandOwner: DeliveryOwner = {
      ui: ctx.ui, isCurrent: () => live(current), phase: () => {}, notice: (text) => notice(ctx, text),
    };
    if (controller.active) {
      controller.toggle(current.config ?? parseConfig({}), commandOwner);
      return;
    }
    if (!current.boundary?.isInstalled()) {
      notice(ctx, "Dictation requires its stock-editor adapter; restore the stock editor and /reload."); return;
    }
    if (current.changing) { notice(ctx, "Dictation configuration is loading; retry shortly."); return; }
    if (!current.config) { notice(ctx, current.configError ?? "Dictation configuration is unavailable."); return; }
    let key: string | undefined;
    try { key = deps.key(current.config); } // fail before microphone startup
    catch (error) { notice(ctx, configFailure(error)); return; }
    const session = ctx.sessionManager;
    const registry = ctx.modelRegistry;
    let lostEditorNotice = false;
    let resultFinished = false;
    const delivery: DeliveryOwner = {
      ui: ctx.ui,
      isCurrent: () => live(current) && owner === delivery && current.boundary!.isInstalled(),
      phase: (phase) => {
        if (phase === "idle") resultFinished = true; // Cleanup can outlive delivery/failure/cancel.
        feedback.phase(phase);
      },
      notice: (text) => { if (live(current) && owner === delivery) notice(ctx, text); },
    };
    owner = delivery;
    const feedback = new Feedback(ctx, deps.clock, () => live(current) && owner === delivery, () => {
      if (current.boundary!.isInstalled()) return true;
      controller.cancel("editor changed"); feedback.clear();
      if (!resultFinished && !lostEditorNotice) { lostEditorNotice = true; notice(ctx, "Dictation discarded: editor changed."); }
      return false;
    });
    current.feedback = feedback;
    controller.toggle(current.config, delivery, {
      record: deps.record,
      transcribe: (audio, config, signal) => deps.transcribe(audio, config, signal, key),
      correct: (raw, config, signal) => deps.correct(raw, config, signal, session, registry),
    });
    void controller.settled().then(() => {
      if (!live(current) || owner !== delivery) return;
      feedback.clear();
      if (!resultFinished && !current.boundary!.isInstalled() && !lostEditorNotice) notice(ctx, "Dictation discarded: editor changed.");
      if (!controller.active) owner = undefined;
    });
  }

  async function command(args: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") { notice(ctx, "pi-oaistt requires interactive terminal mode; no recorder was started."); return; }
    const parts = args.trim().split(/\s+/u).filter(Boolean);
    if (!parts.length) { toggle(ctx); return; }
    if (parts.length === 1 && parts[0] === "cancel") { controller.cancel(); return; }
    if (parts.length === 1 && parts[0] === "help") { notice(ctx, USAGE); return; }
    const current = scope;
    if (!current || !live(current)) { notice(ctx, "Dictation is not ready in this session."); return; }
    if (parts.length === 1 && parts[0] === "status") {
      notice(ctx, `pi-oaistt: ${controller.phase}. Config: ${current.config ? "ready" : "unavailable"}. ` +
        `${current.config ? routeLabel(current.config) : "No active transcription settings"}. ` +
        `Source: ${current.config?.recorder.source ? "configured override" : "automatic (env/default)"}. ` +
        `Correction: ${current.config?.correction.enabled ? `on (${current.config.correction.models.length} candidates)` : "off"}.`);
      return;
    }
    if (current.changing) { notice(ctx, "Dictation configuration is loading; retry shortly."); return; }
    if (parts.length === 1 && parts[0] === "reload") {
      await load(current);
      if (live(current) && current.config) notice(ctx, "Dictation configuration reloaded.");
      return;
    }
    if (parts[0] !== "source" || parts.length > 3 ||
        (parts.length === 3 && (parts[2] !== "--save" || parts[1] === "--save"))) {
      notice(ctx, USAGE); return;
    }
    current.changing = true;
    try {
      const saveOnly = parts.length === 2 && parts[1] === "--save";
      const choice = saveOnly ? undefined : parts[1] ?? await ctx.ui.input(
        "Recording source name (default restores normal routing)", undefined, { signal: current.dialogAbort.signal },
      );
      if (!live(current)) return;
      if (!saveOnly) {
        if (!choice?.trim()) return;
        deps.store.setSource(choice.trim() === "default" ? null : choice.trim());
      }
      if (saveOnly || parts[2] === "--save") await deps.store.saveSource();
      if (!live(current)) return;
      await load(current);
      if (live(current) && current.config) notice(ctx, saveOnly || parts[2] === "--save"
        ? "Recording source saved to pi-oaistt.json." : "Recording source changed temporarily; host routing unchanged.");
    } catch (error) {
      if (live(current)) { notice(ctx, configFailure(error)); await load(current, false); }
    } finally { current.changing = false; }
  }
  pi.registerCommand("oaistt", { description: "Toggle dictation; cancel/status/help/reload/source controls", handler: command });
  pi.registerShortcut("f8", { description: "Start/stop dictation (never submits)", handler: (ctx) => {
    if (ctx.mode === "tui") toggle(ctx);
    else notice(ctx, "pi-oaistt requires interactive terminal mode; no recorder was started.");
  } });
  return { controller }; // test/embedding observation only, not a global service
}

export default function oaistt(pi: ExtensionAPI): void { registerDictation(pi); }
