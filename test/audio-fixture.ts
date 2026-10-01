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
