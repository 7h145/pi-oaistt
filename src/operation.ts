/**
 * pi-oaistt owned operation
 *
 * Purpose: control one cancellable dictation independently of the main agent.
 * Strategy: freeze each pipeline/settings snapshot and guard delivery and cleanup.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { configSnapshot, type Config } from "./config.ts";
import type { CorrectionOutcome } from "./correction.ts";
import { DraftLease } from "./draft.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type Phase = "idle" | "starting" | "recording" | "stopping" | "transcribing" | "correcting" | "cleaning";
export type CancelReason = "cancelled" | "submitted" | "session changed" | "shutdown" | "editor changed" | "draft changed";

export class DictationError extends Error {
  constructor(message: string) { super(message); this.name = "DictationError"; }
}
export class TimeoutError extends DictationError {
  constructor() { super("Dictation request timed out."); this.name = "TimeoutError"; }
}

/** Abort/deadline settlement even if a provider ignores its abort signal. */
export async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  milliseconds: number,
): Promise<T> {
  parent.throwIfAborted();
  const deadline = performance.now() + milliseconds;
  const abort = new AbortController();
  let rejectWait!: (error: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { rejectWait = reject; });
  const cancel = () => {
    abort.abort(parent.reason);
    rejectWait(parent.reason);
  };
  parent.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    const timeout = new TimeoutError();
    abort.abort(timeout);
    rejectWait(timeout);
  }, milliseconds);
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      if (performance.now() >= deadline) throw new TimeoutError();
      return work(abort.signal);
    }), interrupted]);
    parent.throwIfAborted();
    abort.signal.throwIfAborted();
    if (performance.now() >= deadline) throw new TimeoutError();
    return result;
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
    // The work may still be settling. Ensure it cannot stay logically owned.
    abort.abort();
  }
}

export interface AudioFile { path: string; bytes: number }
export interface Recording {
  /** Handle owns startup resources BEFORE ready resolves. */
  ready: Promise<void>;
  stop(): Promise<AudioFile>;
  /** Idempotent, bounded child cleanup including unfinished startup. */
  dispose(): Promise<void>;
}
export type OperationKind = "dictation" | "manual";
export interface Pipeline {
  record(config: Config, signal: AbortSignal, hooks: { limit(): void; fail(error: DictationError): void }): Recording;
  transcribe(audio: AudioFile, config: Config, signal: AbortSignal): Promise<string>;
  correct(raw: string, config: Config, signal: AbortSignal, kind: OperationKind): Promise<CorrectionOutcome>;
}
export interface DeliveryOwner {
  ui: Pick<ExtensionUIContext, "getEditorText" | "setEditorText">;
  isCurrent(): boolean;
  revision?(): number;
  phase(phase: Phase): void;
  notice(message: string): void;
  error?(message: string): void;
}
interface Operation {
  kind: OperationKind; target?: string; revision?: number;
  phase: Phase; config: Config; owner: DeliveryOwner; abort: AbortController; lease: DraftLease;
  cancelled: boolean; stopped: boolean; stopRequested(): void; stopPromise: Promise<void>;
  recording?: Recording; done: Promise<void>; pipeline: Pipeline;
}

/** Shared exclusivity, separate append/replacement policy; never a main-agent signal. */
export class OperationController {
  #active?: Operation;
  #pipeline?: Pipeline;
  constructor(pipeline?: Pipeline) { this.#pipeline = pipeline; }
  get phase(): Phase { return this.#active?.phase ?? "idle"; }
  get kind(): OperationKind | undefined { return this.#active?.kind; }
  get active(): boolean { return this.#active !== undefined; }
  /** Frozen source selection for owned dictation; null means server default. */
  get captureSource(): string | null | undefined {
    return this.#active?.kind === "dictation" ? this.#active.config.recorder.source : undefined;
  }
  toggle(config: Config, owner: DeliveryOwner, pipeline = this.#pipeline): void {
    if (this.#active) { if (this.phase === "recording") this.stop(owner); else this.#busy(owner); return; }
    this.start(config, owner, pipeline);
  }
  #busy(owner: DeliveryOwner): void { if (owner.isCurrent()) owner.notice(`oaistt is ${this.phase}.`); }
  start(config: Config, owner: DeliveryOwner, pipeline = this.#pipeline): void {
    if (this.#active) { this.#busy(owner); return; }
    this.#allocate("dictation", config, owner, pipeline);
  }
  stop(owner?: DeliveryOwner): void {
    const op = this.#active;
    if (op?.phase === "recording" && op.kind === "dictation") this.#stop(op);
    else if (owner) this.#busy(owner);
  }
  correctDraft(config: Config, owner: DeliveryOwner, pipeline = this.#pipeline): void {
    if (this.#active) { this.#busy(owner); return; }
    const target = owner.ui.getEditorText();
    if (!target.trim()) { owner.notice("Nothing to correct."); return; }
    if ([...target].length > 64000) { owner.error?.("Draft correction target exceeds 64000 Unicode code points; draft unchanged."); return; }
    this.#allocate("manual", config, owner, pipeline, target);
  }
  #allocate(kind: OperationKind, config: Config, owner: DeliveryOwner, pipeline: Pipeline | undefined, target?: string): void {
    if (!pipeline) throw new DictationError("oaistt pipeline is not configured.");
    let stopRequested!: () => void;
    const stopPromise = new Promise<void>(resolve => { stopRequested = resolve; });
    const op: Operation = { kind, target, revision: owner.revision?.(), phase: kind === "manual" ? "correcting" : "starting",
      config: configSnapshot(config), owner, abort: new AbortController(), lease: new DraftLease(), cancelled: false, stopped: false,
      stopRequested, stopPromise, done: Promise.resolve(), pipeline };
    this.#active = op;
    op.done = Promise.resolve().then(() => this.#run(op));
    this.#phase(op, op.phase);
  }
  #current(op: Operation): boolean {
    return this.#active === op && !op.cancelled && !op.abort.signal.aborted && op.owner.isCurrent();
  }
  #phase(op: Operation, phase: Phase): void { op.phase = phase; if (this.#current(op)) op.owner.phase(phase); }
  #stop(op: Operation): void {
    if (!this.#current(op) || op.stopped) return;
    op.stopped = true; this.#phase(op, "stopping"); op.stopRequested();
  }
  #check(op: Operation): void {
    op.abort.signal.throwIfAborted();
    if (!this.#current(op)) throw new DOMException("oaistt owner changed", "AbortError");
    if (op.kind === "manual" && op.lease.valid && op.owner.revision?.() !== op.revision) {
      this.cancel("draft changed"); op.abort.signal.throwIfAborted();
    }
  }
  /** Called synchronously by the public editor callback, never a polling guard. */
  contentChanged(): void {
    if (this.#active?.kind === "manual" && this.#active.lease.valid) this.cancel("draft changed");
  }
  cancel(reason: CancelReason = "cancelled"): void {
    const op = this.#active;
    if (!op || op.cancelled || op.phase === "cleaning" || !op.lease.valid) return;
    const visible = op.owner.isCurrent();
    op.cancelled = true; op.lease.invalidate(); op.abort.abort(new DOMException("oaistt cancelled", "AbortError"));
    op.stopRequested(); op.phase = "cleaning";
    if (visible) {
      op.owner.phase("idle");
      if (reason !== "shutdown") {
        const label = op.kind === "manual" ? "Draft correction" : "Dictation";
        const message = reason === "submitted" ? `${label} discarded: prompt submitted before completion.`
          : reason === "session changed" ? `${label} discarded: session changed.`
          : reason === "editor changed" ? `${label} discarded: editor changed.`
          : reason === "draft changed" ? `${label} cancelled: draft changed.` : `${label} cancelled.`;
        op.owner.notice(message);
      }
    }
  }
  async settled(): Promise<void> { await this.#active?.done; }
  async shutdown(): Promise<void> { this.cancel("shutdown"); await this.settled(); }
  async #correction(op: Operation, target: string): Promise<CorrectionOutcome> {
    this.#phase(op, "correcting");
    let result: CorrectionOutcome;
    try { result = await bounded(s => op.pipeline.correct(target, op.config, s, op.kind), op.abort.signal, op.config.correction.totalTimeoutSeconds * 1000); }
    catch { this.#check(op); result = { kind: "exhausted" }; }
    this.#check(op);
    if (result.kind === "corrected" && !result.text.trim()) result = { kind: "exhausted" };
    return result;
  }
  async #run(op: Operation): Promise<void> {
    try {
      this.#check(op);
      if (op.kind === "manual") {
        const result = await this.#correction(op, op.target!);
        if (result.kind === "corrected") {
          op.lease.replace(op.owner.ui, op.target!, result.text, () => {
            this.#check(op); return true;
          });
        } else if (result.kind === "thinking-error") op.owner.error?.(result.message);
        else op.owner.notice("Correction unavailable; draft unchanged.");
      } else {
        op.recording = op.pipeline.record(op.config, op.abort.signal, {
          limit: () => this.#stop(op), fail: error => {
            if (!this.#current(op)) return;
            op.lease.invalidate(); op.abort.abort(error); op.stopRequested();
          },
        });
        await bounded(() => op.recording!.ready, op.abort.signal, 10000);
        this.#check(op); if (!op.stopped) this.#phase(op, "recording");
        await op.stopPromise; this.#check(op); this.#phase(op, "stopping");
        const audio = await bounded(() => op.recording!.stop(), op.abort.signal, (op.config.recorder.stopTimeoutSeconds + 4) * 1000);
        this.#check(op); this.#phase(op, "transcribing");
        const raw = await bounded(s => op.pipeline.transcribe(audio, op.config, s), op.abort.signal, op.config.transcription.totalTimeoutSeconds * 1000);
        this.#check(op); if (!raw.trim()) throw new DictationError("Transcription returned no text.");
        const result = op.config.correction.automatic ? await this.#correction(op, raw) : { kind: "corrected" as const, text: raw };
        this.#check(op);
        if (result.kind === "thinking-error") op.owner.error?.(result.message);
        const delivered = op.lease.append(op.owner.ui, result.kind === "corrected" ? result.text : raw, () => this.#current(op), op.config.delivery.dictationMarker);
        if (delivered && result.kind === "exhausted" && this.#current(op)) op.owner.notice("Correction unavailable; inserted raw transcription.");
      }
    } catch (error) {
      if (!op.cancelled && this.#active === op && op.owner.isCurrent()) {
        const message = error instanceof DictationError ? error.message : "oaistt operation failed.";
        if (op.owner.error) op.owner.error(message); else op.owner.notice(message);
      }
    } finally {
      op.lease.invalidate(); op.abort.abort(); op.phase = "cleaning";
      if (this.#active === op && op.owner.isCurrent()) op.owner.phase("idle");
      try { await op.recording?.dispose(); }
      catch {
        if (!op.cancelled && this.#active === op && op.owner.isCurrent()) op.owner.notice("Dictation cleanup failed; recorder ownership retained.");
        return;
      }
      if (this.#active === op) this.#active = undefined;
    }
  }
}
