// Synthetic child only. Never opens a device or emits user data.
import { writeFileSync } from 'node:fs';
const [mode, path] = process.argv.slice(2);
const wav = Buffer.alloc(mode === 'oversize' ? 4096 : 300);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
if (mode !== 'silence') wav.writeInt16LE(1, 44);
if (mode === 'invalid') wav.write('XXXX', 8);
process.on('SIGINT', () => {
  if (mode === 'hang') return;
  writeFileSync(path, wav);
  process.exit(mode === 'stop-error' ? 2 : 0);
});
if (mode === 'hang') process.on('SIGTERM', () => {});
const partial = Buffer.from(wav); partial.writeUInt32LE(0, 4);
writeFileSync(path, mode === 'header-only' ? partial.subarray(0, 44) : partial);
if (mode === 'exit-error') {
  process.stderr.write('synthetic private backend diagnostic');
  setTimeout(() => process.exit(2), 30);
}
setInterval(() => {}, 1000);
