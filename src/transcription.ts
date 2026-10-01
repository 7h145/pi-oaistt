import { readFile, stat } from "node:fs/promises";
import type { Config } from "./config.ts";
import { bounded, DictationError, type AudioFile } from "./operation.ts";
import { validateWav } from "./wav.ts";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_CODE_POINTS = 64000;

/** JSON {text} only; no redirects or provider-body diagnostics. */
export async function transcribe(
  audio: AudioFile,
  config: Config,
  signal: AbortSignal,
  apiKey: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if ((config.transcription.apiKeyEnv === null && apiKey !== undefined) ||
      (config.transcription.apiKeyEnv !== null && (!apiKey?.trim() || /[\r\n]/u.test(apiKey)))) {
    throw new DictationError("Transcription credential unavailable or inconsistent with configuration.");
  }
  return bounded(async (requestSignal) => {
    try {
      requestSignal.throwIfAborted();
      const info = await stat(audio.path);
      if (!info.isFile() || info.size !== audio.bytes || info.size > config.recorder.maxBytes) {
        throw new DictationError("Private recording changed or exceeded the upload limit.");
      }
      const bytes = await readFile(audio.path);
      const wav = validateWav(bytes, config.recorder.maxBytes);
      if (wav.durationSeconds > config.recorder.maxDurationSeconds + config.recorder.stopTimeoutSeconds) {
        throw new DictationError("Recording duration exceeded the capture/stop budget; audio discarded.");
      }
      requestSignal.throwIfAborted();
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "dictation.wav");
      form.append("model", config.transcription.model);
      form.append("response_format", "json");
      if (config.transcription.language !== null) form.append("language", config.transcription.language);
      const headers: Record<string, string> = {};
      if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetcher(config.transcription.endpoint, {
        method: "POST", body: form, headers, signal: requestSignal, redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new DictationError(`Transcription request failed (HTTP ${response.status}).`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_RESPONSE_BYTES || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new DictationError("Transcription response is invalid or too large.");
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
          if (count > MAX_RESPONSE_BYTES) throw new DictationError("Transcription response is too large.");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      requestSignal.throwIfAborted();
      let result: unknown;
      try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new DictationError("Transcription response is not compatible JSON."); }
      const text = result && typeof result === "object" && "text" in result ? result.text : undefined;
      if (typeof text !== "string" || !text.trim() || [...text].length > MAX_TRANSCRIPT_CODE_POINTS ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
        throw new DictationError("Transcription response contains no usable text.");
      }
      return text.trim();
    } catch (error) {
      requestSignal.throwIfAborted();
      if (error instanceof DictationError) throw error;
      throw new DictationError("Transcription request failed; check endpoint/authentication/network.");
    }
  }, signal, config.transcription.timeoutSeconds * 1000);
}
