/**
 * pi-oaistt owned operation
 *
 * Purpose: control one cancellable dictation independently of the main agent.
 * Strategy: freeze each pipeline/settings snapshot and guard delivery and cleanup.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.1.0
 * Date: 2026-10-01
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { configSnapshot, type Config } from "./config.ts";
import { DraftLease } from "./draft.ts";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type Phase = "idle" | "starting" | "recording" | "stopping" | "transcribing" | "correcting" | "cleaning";
export type CancelReason = "cancelled" | "submitted" | "session changed" | "shutdown" | "editor changed";

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
      return work(abort.signal);
    }), interrupted]);
    parent.throwIfAborted();
    abort.signal.throwIfAborted();
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
export interface Pipeline {
  record(config: Config, signal: AbortSignal, hooks: {
    limit(): void;
    fail(error: DictationError): void;
  }): Recording;
  transcribe(audio: AudioFile, config: Config, signal: AbortSignal): Promise<string>;
  correct(raw: string, config: Config, signal: AbortSignal): Promise<{ text: string; rawFallback: boolean }>;
}
export interface DeliveryOwner {
  ui: Pick<ExtensionUIContext, "getEditorText" | "setEditorText">;
  /** Session generation AND editor-factory identity. No await. */
  isCurrent(): boolean;
  phase(phase: Phase): void;
  /** Fixed, transcript/credential-free strings only. */
  notice(message: string): void;
}
interface Operation {
  phase: Phase;
  config: Config;
  owner: DeliveryOwner;
  abort: AbortController;
  lease: DraftLease;
  cancelled: boolean;
  stopped: boolean;
  stopRequested(): void;
  stopPromise: Promise<void>;
  recording?: Recording;
  done: Promise<void>;
  pipeline: Pipeline;
}

/** Dictation ownership is independent of the main agent. No Pi submission API. */
export class OperationController {
  #active?: Operation;
  #pipeline?: Pipeline;
  constructor(pipeline?: Pipeline) { this.#pipeline = pipeline; }
  get phase(): Phase { return this.#active?.phase ?? "idle"; }
  get active(): boolean { return this.#active !== undefined; }

  toggle(config: Config, owner: DeliveryOwner, pipeline = this.#pipeline): void {
    const current = this.#active;
    if (current) {
      if (current.phase === "starting" || current.phase === "recording") {
        this.#stop(current);
      } else if (owner.isCurrent()) {
        owner.notice(`Dictation is ${current.phase}.`);
      }
      return;
    }
    if (!pipeline) throw new DictationError("Dictation pipeline is not configured.");
    let stopRequested!: () => void;
    const stopPromise = new Promise<void>((resolve) => { stopRequested = resolve; });
    const op: Operation = {
      phase: "starting", config: configSnapshot(config), owner,
      abort: new AbortController(), lease: new DraftLease(),
      cancelled: false, stopped: false, stopRequested, stopPromise,
      done: Promise.resolve(), pipeline,
    };
    this.#active = op;
    // Allocate operation synchronously; release the handler before any lifetime
    // work. Submission in the same tick can cancel even unfinished startup.
    op.done = Promise.resolve().then(() => this.#run(op));
    this.#phase(op, "starting");
  }

  #current(op: Operation): boolean {
    return this.#active === op && !op.cancelled && !op.abort.signal.aborted && op.owner.isCurrent();
  }
  #phase(op: Operation, phase: Phase): void {
    op.phase = phase;
    if (this.#current(op)) op.owner.phase(phase);
  }
  #stop(op: Operation): void {
    if (!this.#current(op) || op.stopped) return;
    op.stopped = true;
    this.#phase(op, "stopping");
    op.stopRequested();
  }
  #check(op: Operation): void {
    op.abort.signal.throwIfAborted();
    if (!this.#current(op)) throw new DOMException("Dictation owner changed", "AbortError");
  }

  /** Synchronous invalidation; cleanup completion can be awaited separately. */
  cancel(reason: CancelReason = "cancelled"): void {
    const op = this.#active;
    if (!op || op.cancelled || op.phase === "cleaning") return;
    const visible = op.owner.isCurrent();
    op.cancelled = true;
    op.lease.invalidate();
    op.abort.abort(new DOMException("Dictation cancelled", "AbortError"));
    op.stopRequested();
    op.phase = "cleaning";
    if (visible) {
      op.owner.phase("idle");
      if (reason !== "shutdown") {
        const message = reason === "submitted"
          ? "Dictation discarded: prompt submitted before completion."
          : reason === "session changed" ? "Dictation discarded: session changed."
          : reason === "editor changed" ? "Dictation discarded: editor changed."
          : "Dictation cancelled.";
        op.owner.notice(message);
      }
    }
  }

  /** Joins only this operation; never waits for or aborts Pi's main agent. */
  async settled(): Promise<void> { await this.#active?.done; }
  async shutdown(): Promise<void> { this.cancel("shutdown"); await this.settled(); }

  async #run(op: Operation): Promise<void> {
    try {
      this.#check(op);
      op.recording = op.pipeline.record(op.config, op.abort.signal, {
        limit: () => this.#stop(op),
        fail: (error) => {
          if (!this.#current(op)) return;
          op.lease.invalidate();
          op.abort.abort(error);
          op.stopRequested();
        },
      });
      await bounded(() => op.recording!.ready, op.abort.signal, 10000);
      this.#check(op);
      if (!op.stopped) this.#phase(op, "recording");
      await op.stopPromise;
      this.#check(op);
      this.#phase(op, "stopping");
      const audio = await bounded(() => op.recording!.stop(), op.abort.signal,
        (op.config.recorder.stopTimeoutSeconds + 4) * 1000);
      this.#check(op);
      this.#phase(op, "transcribing");
      const raw = await bounded(
        (signal) => op.pipeline.transcribe(audio, op.config, signal),
        op.abort.signal, op.config.transcription.timeoutSeconds * 1000,
      );
      this.#check(op);
      if (!raw.trim()) throw new DictationError("Transcription returned no text.");
      let result = { text: raw, rawFallback: false };
      if (op.config.correction.enabled) {
        this.#phase(op, "correcting");
        try {
          result = await bounded(
            (signal) => op.pipeline.correct(raw, op.config, signal),
            op.abort.signal, op.config.correction.totalTimeoutSeconds * 1000,
          );
        } catch {
          this.#check(op); // cancellation is NOT raw fallback
          result = { text: raw, rawFallback: true };
        }
        this.#check(op);
        if (!result.text.trim()) result = { text: raw, rawFallback: true };
      }
      const delivered = op.lease.append(op.owner.ui, result.text, () => this.#current(op));
      if (delivered && result.rawFallback && this.#current(op)) {
        op.owner.notice("Correction unavailable; inserted raw transcription.");
      }
    } catch (error) {
      // Cancelled/obsolete successes and failures never mutate a later session.
      if (!op.cancelled && this.#active === op && op.owner.isCurrent()) {
        op.owner.notice(error instanceof DictationError ? error.message : "Dictation failed.");
      }
    } finally {
      op.lease.invalidate();
      op.abort.abort();
      op.phase = "cleaning";
      if (this.#active === op && op.owner.isCurrent()) op.owner.phase("idle");
      try {
        await op.recording?.dispose();
      } catch {
        if (!op.cancelled && this.#active === op && op.owner.isCurrent()) {
          op.owner.notice("Dictation cleanup failed; recorder ownership retained.");
        }
        // Fail closed: do not spawn another recorder over failed teardown.
        return;
      }
      if (this.#active === op) this.#active = undefined;
    }
  }
}
