/**
 * pi-oaistt recorder tests
 *
 * Purpose: verify recorder behavior without real audio, credentials or provider calls.
 * Strategy: combine synthetic inputs and controlled failures with relevant real APIs.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.ts";
import { recordParecord, type RecorderPlatform } from "../src/recorder.ts";
import type { Recording } from "../src/operation.ts";
import { validateWav } from "../src/wav.ts";
import { fixtureWav } from "./audio-fixture.ts";

const recordings: Recording[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(recordings.splice(0).map((recorder) => recorder.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function platform(mode = "normal", changes: Partial<RecorderPlatform> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-recorder-test-")); dirs.push(dir);
  const calls: string[][] = [];
  const failures: string[] = [];
  let pid: number | undefined;
  let limits = 0;
  const host: Partial<RecorderPlatform> = {
    tempRoot: dir, sourceEnv: undefined, pollMs: 5, startupMs: 1000, graceMs: 50, terminateMs: 50, killMs: 1000,
    query: async (args) => args[0] === "get-default-source" ? "fixture-mic\n"
      : JSON.stringify([{ name: "fixture-mic", mute: false, monitor_of_sink: null }]),
    spawn: (command, args, options) => {
      assert.equal(command, "parecord"); assert.equal(options.shell, false); assert.equal(options.detached, true);
      calls.push(args);
      const child = spawn(process.execPath,
        [fileURLToPath(new URL("./fixtures/recorder.mjs", import.meta.url)), mode, args.at(-1)!], options);
      pid = child.pid;
      return child;
    },
    ...changes,
  };
  return { dir, calls, failures, host, pid: () => pid, limits: () => limits,
    record: (overrides: unknown = {}) => {
      const recording = recordParecord(parseConfig(overrides), new AbortController().signal,
        { limit: () => { limits++; }, fail: (error) => failures.push(error.message) }, host);
      recordings.push(recording); return recording;
    },
  };
}

test("PCM16 WAV parser rejects incomplete/invalid/empty/silence, accepts very quiet signal", () => {
  assert.equal(validateWav(fixtureWav(16), 1024).frames, 16);
  assert.equal(validateWav(fixtureWav(16000), 40000).durationSeconds, 1);
  for (const bytes of [Buffer.alloc(0), fixtureWav(0), fixtureWav(16, true), fixtureWav(16).subarray(0, 70)]) {
    assert.throws(() => validateWav(bytes, 1024));
  }
  const malformed = fixtureWav(); malformed.writeUInt16LE(32, 34);
  assert.throws(() => validateWav(malformed, 1024));
  assert.throws(() => validateWav(fixtureWav(), 44));
});

test("source applied as argv, private WAV finalized only after graceful exit, disposed idempotently", async () => {
  const h = await platform(); const recording = h.record();
  await recording.ready;
  assert.deepEqual(h.calls[0]!.slice(0, -1), ["--device=fixture-mic", "--file-format=wav", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=100", "--process-time-msec=20"]);
  assert.throws(() => validateWav(Buffer.alloc(300), 1024));
  const audio = await recording.stop();
  assert.equal(audio.bytes, 300);
  assert.equal(validateWav(await readFile(audio.path), 1024).frames, 128);
  assert.equal((await stat(audio.path)).mode & 0o077, 0);
  assert.equal((await stat(join(audio.path, ".."))).mode & 0o077, 0);
  assert.equal((await recording.stop()).path, audio.path);
  await recording.dispose(); await recording.dispose();
  assert.deepEqual(await readdir(h.dir), []);
  assert.throws(() => process.kill(h.pid()!, 0), { code: "ESRCH" });
  assert.deepEqual(h.failures, []);
});

test("default source resolved for every recording, source override never changes host defaults", async () => {
  let selected = "first-fixture";
  const queries: string[][] = [];
  const h = await platform("normal", { query: async (args) => {
    queries.push(args);
    return args[0] === "get-default-source" ? selected
      : JSON.stringify([{ name: selected, mute: false }]);
  } });
  const first = h.record(); await first.ready; await first.stop(); await first.dispose();
  selected = "second-fixture";
  const second = h.record({ recorder: { source: selected } }); await second.ready; await second.stop();
  assert.equal(h.calls[0]![0], "--device=first-fixture");
  assert.equal(h.calls[1]![0], "--device=second-fixture");
  assert.equal(queries.filter((args) => args[0] === "get-default-source").length, 1);
  assert.equal(queries.some((args) => args[0]?.startsWith("set-")), false);
});

for (const mode of ["hang", "invalid", "silence", "stop-error"] as const) {
  test(`${mode}: refuse upload candidate and reap/delete owned capture`, async () => {
    const h = await platform(mode); const recording = h.record(); await recording.ready;
    await assert.rejects(recording.stop());
    await recording.dispose();
    assert.throws(() => process.kill(h.pid()!, 0), { code: "ESRCH" });
    assert.deepEqual(await readdir(h.dir), []);
  });
}

test("spawn error and size overflow are redacted and leave no files", async () => {
  const missing = await platform("normal", {
    spawn: (_command, _args, options) => spawn("/nonexistent-synthetic-recorder", [], options),
  });
  const failed = missing.record(); await assert.rejects(failed.ready); await failed.dispose();
  assert.deepEqual(await readdir(missing.dir), []);
  const big = await platform("oversize");
  const tooLarge = big.record({ recorder: { maxBytes: 1024 } });
  await assert.rejects(tooLarge.ready); await tooLarge.dispose();
  assert.deepEqual(await readdir(big.dir), []);
});

for (const source of [{ name: "fixture-mic", mute: true },
  { name: "fixture-mic", monitor_of_sink: 1 }, { name: "different-source" }]) {
  test(`source preflight rejects ${JSON.stringify(source)} without spawning`, async () => {
    const h = await platform("normal", { query: async (args) => args[0] === "get-default-source"
      ? "fixture-mic" : JSON.stringify([source]) });
    const recording = h.record(); await assert.rejects(recording.ready); await recording.dispose();
    assert.equal(h.calls.length, 0);
  });
}

test("abort before startup and during live capture discards and reaps without STT", async () => {
  const h = await platform("hang");
  for (const immediate of [true, false]) {
    const abort = new AbortController();
    const recording = recordParecord(parseConfig({}), abort.signal, { limit: () => {}, fail: () => {} }, h.host);
    recordings.push(recording);
    if (immediate) { abort.abort(); await assert.rejects(recording.ready); }
    else { await recording.ready; abort.abort(); }
    await recording.dispose();
    if (!immediate) assert.throws(() => process.kill(h.pid()!, 0), { code: "ESRCH" });
    assert.deepEqual(await readdir(h.dir), []);
  }
});

test("duration cap requests graceful stop only when audio is ready", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await platform();
  const recording = h.record({ recorder: { maxDurationSeconds: 1 } });
  await recording.ready;
  t.mock.timers.tick(1000);
  assert.equal(h.limits(), 1);
  await recording.stop(); await recording.dispose();
  assert.deepEqual(h.failures, []);
});

test("duration cap before readiness rejects rather than labelling a header-only file REC", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let launched!: () => void;
  const started = new Promise<void>((resolve) => { launched = resolve; });
  const h = await platform("header-only", { startupMs: 5000 });
  const nativeSpawn = h.host.spawn!;
  h.host.spawn = (...args) => { const child = nativeSpawn(...args); launched(); return child; };
  const recording = h.record({ recorder: { maxDurationSeconds: 1 } });
  await started;
  t.mock.timers.tick(1000);
  await assert.rejects(recording.ready, /Duration limit reached before recorder readiness/);
  await recording.dispose();
  assert.equal(h.limits(), 0);
  assert.deepEqual(await readdir(h.dir), []);
});

test("explicit default/null resolves server default, not ambient source override", async () => {
  const h = await platform("normal", { sourceEnv: "synthetic-monitor.monitor" });
  const recording = h.record({ recorder: { source: null } }); await recording.ready;
  assert.equal(h.calls[0]![0], "--device=fixture-mic"); await recording.stop();
});
test("explicit source listing is bounded read-only metadata without Pulse property dumps", async () => {
  const { listRecordingSources } = await import("../src/recorder.ts"); const queries: string[][] = [];
  const items = await listRecordingSources(new AbortController().signal, { query: async args => {
    queries.push(args); return args[0] === "get-default-source" ? "synthetic-mic" : JSON.stringify([
      { name: "synthetic-mic", mute: false, monitor_of_sink: 4294967295, properties: { private: "EXCLUDED_SYNTHETIC_METADATA" } },
      { name: "synthetic.monitor", mute: true, monitor_of_sink: 1 },
    ]);
  } });
  assert.equal(items[0]!.default, true); assert.equal(items[1]!.monitor, true); assert.equal(items[1]!.muted, true);
  assert.doesNotMatch(JSON.stringify(items), /EXCLUDED|properties/); assert.ok(queries.every(args => !args[0]!.startsWith("set-")));
});
