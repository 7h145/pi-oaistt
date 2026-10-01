/**
 * pi-oaistt operation tests
 *
 * Purpose: verify operation behavior without real audio, credentials or provider calls.
 * Strategy: combine synthetic inputs and controlled failures with relevant real APIs.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.1.0
 * Date: 2026-10-01
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import { parseConfig, type Config } from "../src/config.ts";
import { bounded, DictationError, OperationController, TimeoutError,
  type AudioFile, type DeliveryOwner, type Phase, type Pipeline } from "../src/operation.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const ready = deferred<void>();
  const stopped = deferred<AudioFile>();
  const transcription = deferred<string>();
  const correction = deferred<{ text: string; rawFallback: boolean }>();
  let cleanup: Promise<void> = Promise.resolve();
  let text = "typed draft";
  let current = true;
  const phases: Phase[] = [];
  const notices: string[] = [];
  const settings: Config[] = [];
  const signals: AbortSignal[] = [];
  let recordings = 0;
  let stops = 0;
  let disposals = 0;
  let writes = 0;
  let corrections = 0;
  let transcriptions = 0;
  let hooks!: { limit(): void; fail(error: DictationError): void };
  const pipeline: Pipeline = {
    record: (config, signal, callbacks) => {
      recordings++; settings.push(config); signals.push(signal); hooks = callbacks;
      return { ready: ready.promise,
        stop: () => { stops++; return stopped.promise; },
        dispose: () => { disposals++; return cleanup; },
      };
    },
    transcribe: (_audio, config, signal) => {
      transcriptions++; settings.push(config); signals.push(signal); return transcription.promise;
    },
    correct: (_raw, config, signal) => {
      corrections++; settings.push(config); signals.push(signal); return correction.promise;
    },
  };
  const owner: DeliveryOwner = {
    ui: { getEditorText: () => text, setEditorText: (next) => { writes++; text = next; } },
    isCurrent: () => current,
    phase: (phase) => phases.push(phase), notice: (notice) => notices.push(notice),
  };
  const config = parseConfig({});
  const controller = new OperationController(pipeline);
  return { controller, config, owner, ready, stopped, transcription, correction, phases, notices, settings, signals,
    start: () => controller.toggle(config, owner),
    toggle: () => controller.toggle(config, owner),
    setDraft: (next: string) => { text = next; },
    loseOwner: () => { current = false; },
    holdCleanup: (wait: Promise<void>) => { cleanup = wait; },
    counts: () => ({ recordings, stops, disposals, writes, corrections, transcriptions }),
    text: () => text,
    hooks: () => hooks,
  };
}
async function advance(h: ReturnType<typeof harness>, phase: Phase) {
  h.start(); await nextTask();
  if (phase === "starting") return;
  h.ready.resolve(); await nextTask();
  if (phase === "recording") return;
  h.toggle(); await nextTask();
  if (phase === "stopping") return;
  h.stopped.resolve({ path: "/synthetic/audio.wav", bytes: 100 }); await nextTask();
  if (phase === "transcribing") return;
  h.transcription.resolve("raw fixture"); await nextTask();
  assert.equal(h.controller.phase, "correcting");
}

test("responsive start/stop, single operation, config snapshot and latest-draft delivery", async () => {
  const h = harness();
  h.start();
  assert.equal(h.controller.phase, "starting");
  assert.equal(h.counts().recordings, 0); // command returned before lifetime work
  await nextTask();
  h.config.recorder.source = "changed-after-start";
  h.config.transcription.endpoint = "http://changed.invalid/stt";
  h.config.correction.models.push("unlisted/model");
  h.toggle(); // stop during pending startup, not a second operation
  assert.equal(h.controller.phase, "stopping");
  h.ready.resolve(); await nextTask();
  assert.equal(h.counts().stops, 1);
  h.toggle();
  assert.equal(h.counts().recordings, 1);
  h.stopped.resolve({ path: "/synthetic/audio.wav", bytes: 100 }); await nextTask();
  h.transcription.resolve("raw fixture"); await nextTask();
  h.setDraft("typing continued\n");
  h.correction.resolve({ text: "corrected fixture", rawFallback: false });
  await h.controller.settled();
  assert.equal(h.text(), "typing continued\ncorrected fixture");
  assert.equal(h.controller.phase, "idle");
  assert.equal(h.counts().disposals, 1);
  assert.equal(h.counts().writes, 1);
  assert.equal(h.settings.every((config) => config === h.settings[0]), true);
  assert.equal(h.settings[0]!.recorder.source, null);
  assert.equal(h.settings[0]!.transcription.endpoint, "https://api.openai.com/v1/audio/transcriptions");
  assert.deepEqual(h.settings[0]!.correction.models, []);
  assert.equal(h.phases.at(-1), "idle");
});

for (const phase of ["starting", "recording", "stopping", "transcribing", "correcting"] as const) {
  for (const reason of ["cancelled", "submitted", "session changed"] as const) {
    test(`${reason} in ${phase}: synchronous invalidation, one notice, late success discarded`, async () => {
      const h = harness();
      await advance(h, phase);
      assert.equal(h.controller.phase, phase);
      h.controller.cancel(reason);
      h.controller.cancel(reason);
      assert.equal(h.signals[0]!.aborted, true);
      assert.equal(h.notices.length, 1);
      assert.equal(h.phases.at(-1), "idle");
      // Provider/recorder ignores abort and succeeds later. No raw fallback.
      h.ready.resolve();
      h.stopped.resolve({ path: "/synthetic/audio.wav", bytes: 100 });
      h.transcription.resolve("late raw fixture");
      h.correction.resolve({ text: "late corrected fixture", rawFallback: true });
      await h.controller.settled();
      assert.equal(h.text(), "typed draft");
      assert.equal(h.counts().writes, 0);
      assert.equal(h.counts().disposals, 1);
      assert.equal(h.notices.length, 1);
      assert.equal(h.controller.active, false);
    });
  }
}

test("immediate capture in initiating tick prevents even recorder startup", async () => {
  const h = harness();
  h.start(); h.controller.cancel("submitted");
  await h.controller.settled();
  assert.equal(h.counts().recordings, 0);
  assert.equal(h.notices.length, 1);
});

test("cancellation cleans up while uncooperative provider promise remains pending", async () => {
  const h = harness();
  await advance(h, "transcribing");
  h.controller.cancel();
  await h.controller.settled();
  assert.equal(h.controller.active, false);
  assert.equal(h.counts().disposals, 1);
  assert.equal(h.signals[1]!.aborted, true);
  h.transcription.reject(new Error("late synthetic provider failure"));
  await nextTask();
  assert.equal(h.notices.length, 1);
});

test("cancelled recorder ownership blocks new start until cleanup completes", async () => {
  const h = harness();
  const cleanup = deferred<void>();
  h.holdCleanup(cleanup.promise);
  await advance(h, "recording");
  h.controller.cancel();
  await nextTask();
  h.toggle();
  assert.equal(h.controller.phase, "cleaning");
  assert.equal(h.counts().recordings, 1);
  cleanup.resolve();
  await h.controller.settled();
  h.start(); await nextTask();
  assert.equal(h.counts().recordings, 2);
  h.controller.cancel(); await h.controller.settled();
});

test("shutdown idempotently clears phase, with no cancellation notice", async () => {
  const h = harness();
  await advance(h, "recording");
  await h.controller.shutdown();
  await h.controller.shutdown();
  assert.equal(h.controller.active, false);
  assert.equal(h.phases.at(-1), "idle");
  assert.deepEqual(h.notices, []);
  assert.equal(h.counts().disposals, 1);
});

test("disabled correction inserts raw text without failure notice or request", async () => {
  const h = harness(); h.config.correction.enabled = false;
  await advance(h, "transcribing");
  h.transcription.resolve("raw fixture"); await h.controller.settled();
  assert.equal(h.text(), "typed draft raw fixture");
  assert.equal(h.counts().corrections, 0);
  assert.deepEqual(h.notices, []);
});

for (const outcome of ["exhausted", "error", "empty"] as const) {
  test(`correction ${outcome} inserts raw plus one notice`, async () => {
    const h = harness();
    await advance(h, "correcting");
    if (outcome === "error") h.correction.reject(new Error("synthetic provider details"));
    else h.correction.resolve({ text: outcome === "empty" ? "" : "raw fixture", rawFallback: true });
    await h.controller.settled();
    assert.equal(h.text(), "typed draft raw fixture");
    assert.deepEqual(h.notices, ["Correction unavailable; inserted raw transcription."]);
  });
}

test("total correction deadline yields raw, even when provider ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); h.config.correction.totalTimeoutSeconds = 1;
  await advance(h, "correcting");
  t.mock.timers.tick(1000); await h.controller.settled();
  assert.equal(h.text(), "typed draft raw fixture");
  assert.equal(h.signals[2]!.aborted, true);
  assert.equal(h.notices.length, 1);
});

test("transcription timeout leaves draft unchanged with a redacted failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness(); h.config.transcription.timeoutSeconds = 1;
  await advance(h, "transcribing");
  t.mock.timers.tick(1000); await h.controller.settled();
  assert.equal(h.text(), "typed draft");
  assert.equal(h.counts().corrections, 0);
  assert.deepEqual(h.notices, ["Dictation request timed out."]);
});

test("unexpected recorder failure, empty STT, and opaque errors clean up safely", async () => {
  for (const scenario of ["recorder", "empty", "provider"] as const) {
    const h = harness();
    await advance(h, scenario === "recorder" ? "recording" : "transcribing");
    if (scenario === "recorder") h.hooks().fail(new DictationError("Recorder stopped unexpectedly."));
    else if (scenario === "empty") h.transcription.resolve("   ");
    else h.transcription.reject(new Error("synthetic secret provider message"));
    await h.controller.settled();
    assert.equal(h.text(), "typed draft");
    assert.equal(h.counts().disposals, 1);
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0]!.includes("secret"), false);
    assert.equal(h.phases.at(-1), "idle");
  }
});

test("late old limit/failure hooks cannot mutate a later operation", async () => {
  const h = harness(); await advance(h, "recording");
  const oldHooks = h.hooks();
  await h.controller.shutdown();
  h.start(); await nextTask();
  assert.equal(h.controller.phase, "recording");
  oldHooks.limit(); oldHooks.fail(new DictationError("stale failure"));
  assert.equal(h.controller.phase, "recording");
  assert.equal(h.notices.length, 0);
  await h.controller.shutdown();
});

test("replacement identity without explicit cancellation still prevents all delivery/status", async () => {
  const h = harness(); await advance(h, "correcting");
  const phases = [...h.phases];
  h.loseOwner();
  h.correction.resolve({ text: "obsolete fixture", rawFallback: true });
  await h.controller.settled();
  assert.equal(h.counts().writes, 0);
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.phases, phases);
});

test("failed cleanup retains ownership and prevents another recorder", async () => {
  const h = harness(); await advance(h, "transcribing");
  h.holdCleanup(Promise.reject(new Error("synthetic cleanup failure")));
  h.transcription.reject(new Error("synthetic failure"));
  await h.controller.settled();
  assert.equal(h.controller.phase, "cleaning");
  h.toggle();
  assert.equal(h.counts().recordings, 1);
  assert.equal(h.notices.includes("Dictation cleanup failed; recorder ownership retained."), true);
});

test("bounded helper distinguishes timeout/cancellation and checks ignored abort", async () => {
  const parent = new AbortController();
  const wait = deferred<string>();
  let signal!: AbortSignal;
  const result = bounded((child) => { signal = child; return wait.promise; }, parent.signal, 1000);
  await nextTask();
  const reason = new DOMException("synthetic cancel", "AbortError");
  parent.abort(reason);
  await assert.rejects(result, (error) => error === reason);
  assert.equal(signal.aborted, true);
  wait.resolve("late fixture");
  const other = new AbortController();
  await assert.rejects(bounded(() => new Promise(() => {}), other.signal, 1), TimeoutError);
});

test("submission after delivery during held cleanup does not report an unfinished-result discard", async () => {
  const h = harness(); h.config.correction.enabled = false;
  const cleanup = deferred<void>(); h.holdCleanup(cleanup.promise);
  await advance(h, "transcribing");
  h.transcription.resolve("already delivered fixture"); await nextTask();
  assert.equal(h.text(), "typed draft already delivered fixture");
  assert.equal(h.controller.phase, "cleaning");
  h.controller.cancel("submitted");
  assert.deepEqual(h.notices, []);
  cleanup.resolve(); await h.controller.settled();
});
