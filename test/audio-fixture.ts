/**
 * pi-oaistt synthetic audio fixture
 *
 * Purpose: provide deterministic PCM/WAV input without capturing real audio.
 * Strategy: construct small known sample buffers for structural and client tests.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

export function fixtureWav(frames = 128, silence = false): Buffer {
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40);
  if (!silence) for (let i = 0; i < frames; i++) wav.writeInt16LE(i % 2 ? 1 : -1, 44 + i * 2);
  return wav;
}
