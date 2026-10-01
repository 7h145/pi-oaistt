/**
 * pi-oaistt WAV validation
 *
 * Purpose: reject malformed, silent or out-of-budget PCM recordings before upload.
 * Strategy: validate RIFF structure, PCM metadata, frames and digital silence.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.1.0
 * Date: 2026-10-01
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { DictationError } from "./operation.ts";

export interface WavInfo { frames: number; sampleRate: number; durationSeconds: number }

/** Only the recorder's mono PCM16/16kHz RIFF WAV contract, not arbitrary codecs. */
export function validateWav(bytes: Uint8Array, maxBytes: number): WavInfo {
  const wav = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => { throw new DictationError("Recorder produced invalid or incomplete WAV audio."); };
  if (wav.length < 44 || wav.length > maxBytes || wav.toString("ascii", 0, 4) !== "RIFF" ||
      wav.toString("ascii", 8, 12) !== "WAVE" || wav.readUInt32LE(4) !== wav.length - 8) invalid();
  let format = false;
  let data: Buffer | undefined;
  let offset = 12;
  while (offset < wav.length) {
    if (offset + 8 > wav.length) invalid();
    const kind = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > wav.length || end + (size % 2) > wav.length) invalid();
    if (kind === "fmt ") {
      if (format || size < 16 || wav.readUInt16LE(offset + 8) !== 1 ||
          wav.readUInt16LE(offset + 10) !== 1 || wav.readUInt32LE(offset + 12) !== 16000 ||
          wav.readUInt32LE(offset + 16) !== 32000 || wav.readUInt16LE(offset + 20) !== 2 ||
          wav.readUInt16LE(offset + 22) !== 16) invalid();
      format = true;
    } else if (kind === "data") {
      if (data || !size || size % 2 !== 0) invalid();
      data = wav.subarray(offset + 8, end);
    }
    offset = end + (size % 2);
  }
  if (!format || !data) invalid();
  const samples = data!;
  let signal = false;
  for (let i = 0; i < samples.length; i += 2) {
    if (samples.readInt16LE(i) !== 0) { signal = true; break; }
  }
  // Reject exact digital silence only; do not reject quiet speech by RMS/volume.
  if (!signal) throw new DictationError("No audio signal detected; check microphone mute/source.");
  const frames = samples.length / 2;
  return { frames, sampleRate: 16000, durationSeconds: frames / 16000 };
}
