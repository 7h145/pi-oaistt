/**
 * pi-oaistt transcription client
 *
 * Purpose: send validated WAV audio to the configured compatible transcription URL.
 * Strategy: bound multipart requests/results and redact failures without redirects.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { readFile, stat } from "node:fs/promises";
import type { Config, Profile } from "./config.ts";
import { bounded, DictationError, TimeoutError, type AudioFile } from "./operation.ts";
import { validateWav } from "./wav.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_CODE_POINTS = 64000;

export type FailureReason = "credentials unavailable" | "network failure" | "timeout" | "authentication failed" | "throttled" | "server error" | "HTTP failure" | "invalid response";
export class TranscriptionFailure extends DictationError {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) { super(`Transcription failed: ${reason}.`); this.reason = reason; }
}

/** Validate/read once per chain; input failures are never profile fallback. */
export async function prepareAudio(audio: AudioFile, config: Config): Promise<Uint8Array> {
  try {
    const info = await stat(audio.path);
    if (!info.isFile() || info.size !== audio.bytes || info.size > config.recorder.maxBytes) throw new DictationError("Private recording changed or exceeded the upload limit.");
    const bytes = await readFile(audio.path);
    const wav = validateWav(bytes, config.recorder.maxBytes);
    if (wav.durationSeconds > config.recorder.maxDurationSeconds + config.recorder.stopTimeoutSeconds) throw new DictationError("Recording duration exceeded the capture/stop budget; audio discarded.");
    return bytes;
  } catch (error) {
    if (error instanceof DictationError) throw error;
    throw new DictationError("Cannot read private recording; audio discarded.");
  }
}

/** JSON {text} only; no redirects or provider-body diagnostics. */
export async function transcribe(
  audio: AudioFile,
  config: Config,
  signal: AbortSignal,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
  profile: Profile = config.transcription.profiles[config.transcription.order[0]!]!,
  prepared?: Uint8Array,
): Promise<string> {
  signal.throwIfAborted();
  if ((profile.auth.type === "none" && apiKey !== undefined) ||
      (profile.auth.type !== "none" && (!apiKey?.trim() || /[\r\n]/u.test(apiKey)))) {
    throw new TranscriptionFailure("credentials unavailable");
  }
  return bounded(async (requestSignal) => {
    try {
      requestSignal.throwIfAborted();
      const bytes = prepared ?? await prepareAudio(audio, config);
      requestSignal.throwIfAborted();
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "dictation.wav");
      form.append("model", profile.model);
      form.append("response_format", "json");
      if (profile.language !== null) form.append("language", profile.language);
      const headers: Record<string, string> = {};
      if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetcher(profile.endpoint, {
        method: "POST", body: form, headers, signal: requestSignal, redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new TranscriptionFailure([401, 403].includes(response.status) ? "authentication failed" : response.status === 429 ? "throttled" : response.status >= 500 ? "server error" : "HTTP failure");
      }
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_RESPONSE_BYTES || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new TranscriptionFailure("invalid response");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let count = 0;
      try {
        for (;;) {
          requestSignal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          count += part.value.byteLength;
          if (count > MAX_RESPONSE_BYTES) throw new TranscriptionFailure("invalid response");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      requestSignal.throwIfAborted();
      let result: unknown;
      try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new TranscriptionFailure("invalid response"); }
      const text = result && typeof result === "object" && "text" in result ? result.text : undefined;
      if (typeof text !== "string" || !text.trim() || [...text].length > MAX_TRANSCRIPT_CODE_POINTS ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
        throw new TranscriptionFailure("invalid response");
      }
      return text.trim();
    } catch (error) {
      requestSignal.throwIfAborted();
      if (error instanceof DictationError) throw error;
      throw new TranscriptionFailure("network failure");
    }
  }, signal, profile.attemptTimeoutSeconds * 1000);
}


/** Following-only candidates for a new operation; shared with the status preview. */
export function transcriptionCandidates(config: Config, selected: string): string[] {
  const index = config.transcription.order.indexOf(selected);
  if (index < 0) return [];
  return config.transcription.automaticFallback ? config.transcription.order.slice(index) : [selected];
}

/** Consent-limited sequential chain; identical owned WAV, fresh bodies/readers. */
export async function transcriptionChain(
  config: Config, selected: string, signal: AbortSignal,
  attempt: (profile: Profile, signal: AbortSignal) => Promise<string>,
  warning: (failed: string, reason: FailureReason, next: string) => void = () => {},
  startedDeadline?: number,
  isCurrent?: () => boolean,
): Promise<{ text: string; profile: string }> {
  const check = (ownedSignal: AbortSignal) => {
    ownedSignal.throwIfAborted();
    if (isCurrent && !isCurrent()) throw new DOMException("Transcription ownership changed", "AbortError");
  };
  check(signal);
  const names = transcriptionCandidates(config, selected);
  if (!names.length) throw new DictationError("Unknown or inactive transcription profile.");
  const deadline = Math.min(startedDeadline ?? Infinity, performance.now() + config.transcription.totalTimeoutSeconds * 1000);
  return bounded(async totalSignal => {
    let failed: { name: string; reason: FailureReason } | undefined;
    for (const name of names) {
      check(totalSignal);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new TimeoutError();
      if (failed) warning(failed.name, failed.reason, name);
      check(totalSignal);
      if (performance.now() >= deadline) throw new TimeoutError();
      const profile = config.transcription.profiles[name]!;
      try {
        const text = await bounded(s => { check(s); if (performance.now() >= deadline) throw new TimeoutError(); return attempt(profile, s); }, totalSignal, Math.min(deadline - performance.now(), profile.attemptTimeoutSeconds * 1000));
        check(totalSignal);
        if (performance.now() >= deadline) throw new TimeoutError();
        if (!text.trim()) throw new TranscriptionFailure("invalid response");
        return { text, profile: name };
      } catch (error) {
        check(totalSignal);
        if (!(error instanceof TranscriptionFailure) && !(error instanceof TimeoutError)) throw error;
        failed = { name, reason: error instanceof TimeoutError ? "timeout" : error.reason };
      }
    }
    throw new DictationError("Transcription unavailable; draft unchanged.");
  }, signal, Math.max(0, deadline - performance.now()));
}
