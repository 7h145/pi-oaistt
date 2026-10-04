/**
 * pi-oaistt recorder
 *
 * Purpose: capture bounded private WAV audio from an explicit Linux microphone route.
 * Strategy: preflight Pulse sources and own parecord startup, stop, reap and disposal.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { spawn, execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DictationError, type AudioFile, type Recording, type Pipeline } from "./operation.ts";
import type { Config } from "./config.ts";
import { validateWav } from "./wav.ts";

const exec = promisify(execFile);
type Exit = { code: number | null; signal: NodeJS.Signals | null; spawnError?: boolean; missingTool?: boolean };
type AudioTool = "pactl" | "parecord";
const missingAudioTools = (tools: readonly AudioTool[]) =>
  new DictationError(`Missing audio tools: ${tools.join(", ")} (package: pulseaudio-utils)`);

/** Read-only version probes, only when recording is requested; never install. */
export async function checkAudioTools(signal: AbortSignal,
  probe: (tool: AudioTool, signal: AbortSignal) => Promise<void> = async (tool, signal) => {
    await exec(tool, ["--version"], {
      signal, timeout: 2500, killSignal: "SIGKILL", maxBuffer: 16 * 1024,
    });
  },
): Promise<void> {
  const missing: AudioTool[] = [];
  for (const tool of ["pactl", "parecord"] as const) {
    signal.throwIfAborted();
    try { await probe(tool, signal); }
    catch (error) {
      signal.throwIfAborted();
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") missing.push(tool);
      // A normal nonzero exit still proves the executable was found.
      else if (typeof code !== "number") throw new DictationError("Cannot check audio tools; check executable access.");
    }
    signal.throwIfAborted();
  }
  if (missing.length) throw missingAudioTools(missing);
}

export interface RecorderPlatform {
  checkTools(signal: AbortSignal): Promise<void>;
  query(args: string[], signal: AbortSignal): Promise<string>;
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
  tempRoot: string;
  sourceEnv?: string;
  /** Test-only timing injection; not user config/custom shell support. */
  pollMs: number;
  startupMs: number;
  terminateMs: number;
  killMs: number;
  graceMs?: number;
}
const platform: RecorderPlatform = {
  checkTools: checkAudioTools,
  query: async (args, signal) => {
    try {
      const result = await exec("pactl", args, {
        signal, timeout: 2500, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
      return result.stdout;
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw missingAudioTools(["pactl"]);
      throw new DictationError("Cannot inspect recording source; check Pulse server access.");
    }
  },
  spawn, tempRoot: tmpdir(),
  pollMs: 100, startupMs: 5000, terminateMs: 500, killMs: 1000,
};

async function recordingSource(config: Config, signal: AbortSignal, host: RecorderPlatform): Promise<string> {
  const name = config.recorder.source ??
    (await host.query(["get-default-source"], signal)).trim();
  signal.throwIfAborted();
  if (!name || /[\u0000-\u001f\u007f]/u.test(name)) throw new DictationError("No recording source is available.");
  let sources: unknown;
  try { sources = JSON.parse(await host.query(["--format=json", "list", "sources"], signal)); }
  catch (error) {
    if (error instanceof DictationError || signal.aborted) throw error;
    throw new DictationError("Pulse source information is incompatible.");
  }
  signal.throwIfAborted();
  if (!Array.isArray(sources)) throw new DictationError("Pulse source information is incompatible.");
  const source = sources.find((item) => item && typeof item === "object" && item.name === name);
  if (!source) throw new DictationError("Selected recording source is unavailable.");
  const monitor = source.monitor_of_sink;
  if (name.endsWith(".monitor") || (monitor !== undefined && monitor !== null &&
      monitor !== 4294967295 && monitor !== "4294967295")) {
    throw new DictationError("Selected source is a playback monitor, not a microphone.");
  }
  if (source.mute === true) throw new DictationError("Selected microphone is muted; unmute it on the host.");
  return name;
}

class ParecordRecording implements Recording {
  readonly ready: Promise<void>;
  #config: Config;
  #host: RecorderPlatform;
  #hooks: Parameters<Pipeline["record"]>[2];
  #abort = new AbortController();
  #parent: AbortSignal;
  #parentCancel: () => void;
  #dir?: string;
  #path?: string;
  #child?: ChildProcess;
  #exit?: Exit;
  #exited: Promise<Exit>;
  #resolveExit!: (exit: Exit) => void;
  #poll?: ReturnType<typeof setInterval>;
  #duration?: ReturnType<typeof setTimeout>;
  #stopping = false;
  #ready = false;
  #disposed = false;
  #disposePromise?: Promise<void>;
  #stopPromise?: Promise<AudioFile>;

  constructor(config: Config, parent: AbortSignal, hooks: Parameters<Pipeline["record"]>[2], host: RecorderPlatform) {
    this.#config = config; this.#parent = parent; this.#hooks = hooks; this.#host = host;
    this.#parentCancel = () => this.#abort.abort(parent.reason);
    parent.addEventListener("abort", this.#parentCancel, { once: true });
    if (parent.aborted) this.#parentCancel();
    this.#exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.ready = this.#setup();
    void this.ready.catch(() => {}); // owned startup may be cancelled before observer attaches
  }

  async #setup(): Promise<void> {
    const signal = this.#abort.signal;
    signal.throwIfAborted();
    await this.#host.checkTools(signal);
    signal.throwIfAborted();
    const source = await recordingSource(this.#config, signal, this.#host);
    signal.throwIfAborted();
    this.#dir = await mkdtemp(join(this.#host.tempRoot, "pi-oaistt-"));
    signal.throwIfAborted();
    this.#path = join(this.#dir, "capture.wav");
    await writeFile(this.#path, "", { flag: "wx", mode: 0o600 });
    signal.throwIfAborted();
    const args = [
      `--device=${source}`, "--file-format=wav", "--format=s16le", "--rate=16000", "--channels=1",
      // Parecord's large default buffer discarded ~2s at SIGINT in the live
      // monitor check. These are per-stream requests, not host audio changes.
      "--latency-msec=100", "--process-time-msec=20", this.#path,
    ];
    this.#child = this.#host.spawn("parecord", args, {
      shell: false, detached: true, stdio: ["ignore", "ignore", "pipe"],
    });
    // Discard backend diagnostics: they can contain device paths or other data.
    this.#child.stderr?.resume();
    this.#child.once("error", (error: NodeJS.ErrnoException) => this.#finishExit({
      code: null, signal: null, spawnError: true, missingTool: error.code === "ENOENT",
    }));
    this.#child.once("exit", (code, signal) => this.#finishExit({ code, signal }));
    this.#duration = setTimeout(() => {
      if (this.#disposed || this.#abort.signal.aborted || this.#stopping) return;
      if (this.#ready) this.#hooks.limit();
      else {
        const error = new DictationError("Duration limit reached before recorder readiness; audio discarded.");
        this.#hooks.fail(error);
        this.#abort.abort(error);
      }
    }, this.#config.recorder.maxDurationSeconds * 1000);

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      let polling = false;
      const aborted = () => { clearTimeout(startup); reject(signal.reason); };
      const startup = setTimeout(() => {
        const error = new DictationError("Recorder did not become ready; audio discarded.");
        this.#abort.abort(error);
      }, this.#host.startupMs);
      signal.addEventListener("abort", aborted, { once: true });
      const tick = async () => {
        if (polling || signal.aborted || this.#disposed) return;
        polling = true;
        try {
          if (this.#exit) {
            if (this.#stopping) return;
            throw new DictationError("Recorder exited before capture was ready.");
          }
          const info = await stat(this.#path!);
          signal.throwIfAborted();
          if (info.size > this.#config.recorder.maxBytes) {
            throw new DictationError("Recording size limit reached; audio discarded.");
          }
          // Don't claim REC merely because a child was spawned. First audio
          // bytes must have reached the private file (header alone isn't ready).
          if (!ready && info.size > 44) {
            ready = true; this.#ready = true; clearTimeout(startup);
            signal.removeEventListener("abort", aborted);
            resolve();
          }
        } catch (error) {
          if (!ready) { clearTimeout(startup); signal.removeEventListener("abort", aborted); reject(error); }
          if (!signal.aborted && !this.#disposed) {
            const safe = error instanceof DictationError ? error : new DictationError("Cannot inspect private recording file.");
            this.#hooks.fail(safe);
            this.#abort.abort(safe);
          }
        } finally { polling = false; }
      };
      this.#poll = setInterval(() => { void tick(); }, this.#host.pollMs);
      void tick();
    });
    signal.throwIfAborted();
  }

  #finishExit(exit: Exit): void {
    if (this.#exit) return;
    this.#exit = exit;
    this.#resolveExit(exit);
    if (!this.#stopping && !this.#disposed && !this.#abort.signal.aborted) {
      const error = exit.missingTool ? missingAudioTools(["parecord"]) : new DictationError(exit.spawnError
        ? "Cannot start parecord; check executable access."
        : "Recorder stopped unexpectedly; audio discarded.");
      this.#hooks.fail(error);
      this.#abort.abort(error);
    }
  }

  #signal(signal: NodeJS.Signals): void {
    if (!this.#child?.pid || this.#exit) return;
    try { process.kill(-this.#child.pid, signal); } // ONLY the owned detached group
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw new DictationError("Cannot stop owned recorder.");
      }
    }
  }
  async #waitExit(ms: number): Promise<Exit | undefined> {
    if (this.#exit) return this.#exit;
    let timer!: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([this.#exited, new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      })]);
    } finally { clearTimeout(timer); }
  }
  async #terminate(): Promise<void> {
    if (!this.#child || this.#exit) return;
    this.#signal("SIGTERM");
    if (await this.#waitExit(this.#host.terminateMs)) return;
    this.#signal("SIGKILL");
    if (!(await this.#waitExit(this.#host.killMs))) throw new DictationError("Owned recorder could not be reaped.");
  }

  stop(): Promise<AudioFile> {
    this.#stopPromise ??= this.#stop();
    return this.#stopPromise;
  }
  async #stop(): Promise<AudioFile> {
    await this.ready;
    this.#abort.signal.throwIfAborted();
    this.#stopping = true;
    clearTimeout(this.#duration);
    clearInterval(this.#poll);
    this.#signal("SIGINT");
    const exit = await this.#waitExit(this.#host.graceMs ?? this.#config.recorder.stopTimeoutSeconds * 1000);
    if (!exit) {
      await this.#terminate();
      throw new DictationError("Recorder did not finalize in time; audio discarded.");
    }
    this.#abort.signal.throwIfAborted();
    if (exit.spawnError || (exit.code !== 0 && exit.signal !== "SIGINT")) {
      throw new DictationError("Recorder failed to finalize; audio discarded.");
    }
    clearInterval(this.#poll);
    const bytes = await readFile(this.#path!);
    const wav = validateWav(bytes, this.#config.recorder.maxBytes);
    if (wav.durationSeconds > this.#config.recorder.maxDurationSeconds + this.#config.recorder.stopTimeoutSeconds) {
      throw new DictationError("Recording duration exceeded the capture/stop budget; audio discarded.");
    }
    this.#abort.signal.throwIfAborted();
    return { path: this.#path!, bytes: bytes.length };
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#abort.abort(new DOMException("Recording disposed", "AbortError"));
    clearInterval(this.#poll); clearTimeout(this.#duration);
    this.#parent.removeEventListener("abort", this.#parentCancel);
    this.#disposePromise = this.#dispose();
    return this.#disposePromise;
  }
  async #dispose(): Promise<void> {
    await this.ready.catch(() => {});
    if (this.#child && !this.#exit) {
      this.#signal("SIGINT");
      if (!(await this.#waitExit(this.#host.terminateMs))) await this.#terminate();
    }
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true });
  }
}

export function recordParecord(
  config: Config, signal: AbortSignal, hooks: Parameters<Pipeline["record"]>[2],
  overrides: Partial<RecorderPlatform> = {},
): Recording {
  if (process.platform !== "linux") throw new DictationError("Dictation recording is supported on Linux only.");
  return new ParecordRecording(config, signal, hooks, { ...platform, ...overrides });
}


/** Explicit user listing only: bounded source labels, no Pulse properties dump. */
export async function listRecordingSources(signal: AbortSignal, host: Pick<RecorderPlatform, "query"> = platform) {
  const current = (await host.query(["get-default-source"], signal)).trim();
  let sources: unknown;
  try { sources = JSON.parse(await host.query(["--format=json", "list", "sources"], signal)); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof DictationError) throw error;
    throw new DictationError("Pulse source information is incompatible.");
  }
  signal.throwIfAborted();
  if (!Array.isArray(sources)) throw new DictationError("Pulse source information is incompatible.");
  return sources.slice(0, 64).filter(s => s && typeof s.name === "string").map(s => ({
    name: s.name.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 512), default: s.name === current, muted: s.mute === true,
    monitor: s.name.endsWith(".monitor") || s.monitor_of_sink != null && s.monitor_of_sink !== 4294967295 && s.monitor_of_sink !== "4294967295",
  }));
}
