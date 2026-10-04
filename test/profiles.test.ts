/**
 * Purpose: Verify profile policy, configuration persistence and preference races.
 * Strategy: Use only synthetic configuration, candidates and bounded requests.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, ConfigStore, ConfigError, configSnapshot, transcriptionKey } from "../src/config.ts";
import { ProfileSelection, safeLabel } from "../src/profiles.ts";
import { canonicalKey, nativeSafe } from "../src/keys.ts";
import { transcriptionChain, TranscriptionFailure } from "../src/transcription.ts";
import { DictationError } from "../src/operation.ts";
const raw = () => ({ transcription: { order: ["local", "remote", "third"], profiles: Object.fromEntries(["local", "remote", "third", "standby"].map(n => [n, { endpoint: `http://127.0.0.1:1/${n}`, model: "same-model", auth: { type: "none" } }])), automaticFallback: false } });

test("strict schema separates identity, inherited/null tuning and candidate membership", () => {
  const value = raw();
  const c = parseConfig({ ...value, transcription: { ...value.transcription, defaults: { language: "en", attemptTimeoutSeconds: 1.25 },
    profiles: { ...value.transcription.profiles, remote: { ...value.transcription.profiles.remote, language: null } } },
    correction: { order: ["$current", "p/m", "p/m"], defaults: { thinkingLevel: "low", attemptTimeoutSeconds: 2.5 }, modelSettings: { "p/m": { thinkingLevel: null } }, context: { maxChars: 0 }, automatic: false }, delivery: { dictationMarker: false } });
  assert.equal(c.transcription.profiles.local!.language, "en"); assert.equal(c.transcription.profiles.remote!.language, null);
  assert.equal(c.transcription.profiles.third!.attemptTimeoutSeconds, 1.25);
  assert.equal(c.correction.modelSettings["p/m"]!.thinkingLevel, null); assert.equal(c.correction.modelSettings["p/m"]!.attemptTimeoutSeconds, 2.5);
  assert.equal(c.correction.context.maxChars, 0); assert.equal(c.correction.automatic, false);
  assert.equal(c.transcription.automaticFallback, false);
  const frozen = configSnapshot(c);
  assert.throws(() => { frozen.transcription.profiles.local!.auth.type = "env"; }, TypeError);
  assert.throws(() => { frozen.keybindings["editor.correct"].push("f6"); }, TypeError);
});
for (const value of [
  { transcription: { endpoint: "http://127.0.0.1:1/stt" } }, { correction: { models: [] } },
  { correction: { attemptTimeoutSeconds: 1 } }, { transcription: { order: ["local"], profiles: { local: { model: "fixture", auth: { type: "none" } } } } },
  { transcription: { ...raw().transcription, order: ["missing"] } }, { transcription: { ...raw().transcription, order: ["local", "local"] } },
  { transcription: { ...raw().transcription, order: [] } }, { transcription: { ...raw().transcription, automaticFallback: null } },
  { transcription: { ...raw().transcription, totalTimeoutSeconds: 0 } }, { transcription: { ...raw().transcription, totalTimeoutSeconds: Infinity } },
  { transcription: { ...raw().transcription, defaults: { attemptTimeoutSeconds: null } } }, { transcription: { ...raw().transcription, defaults: { endpoint: "http://127.0.0.1:1/stt" } } },
  { transcription: { ...raw().transcription, profiles: { ...raw().transcription.profiles, standby: { endpoint: "http://127.0.0.1:1/stt", model: "fixture" } } } },
  { correction: { modelSettings: { $current: { thinkingLevel: null } } } }, { delivery: { dictationMarker: null } },
]) test("malformed/unknown/inactive configuration cannot silently supply a route", () => assert.throws(() => parseConfig(value), ConfigError));

test("thinking parse faults and invalid keys localize, never silently null/default", () => {
  const c = parseConfig({ correction: { defaults: { thinkingLevel: 123 } }, keybindings: { "editor.correct": false, unknown: "f6" } });
  assert.deepEqual(c.correction.defaults.thinkingLevel, { invalid: true });
  assert.deepEqual(c.keybindings["editor.correct"], []); assert.deepEqual(c.keybindings["dictation.toggle"], ["f8"]); assert.equal(c.keyErrors.length, 2);
  const duplicate = parseConfig({ keybindings: { "editor.correct": ["alt+ctrl+x", "f7"], "operation.cancel": "ctrl+alt+x", "dictation.start": [] } });
  assert.deepEqual(duplicate.keybindings["editor.correct"], ["f7"]); assert.deepEqual(duplicate.keybindings["operation.cancel"], []);
  assert.equal(canonicalKey("shift+ctrl+Return"), "ctrl+shift+enter"); assert.equal(canonicalKey("ctrl++"), "ctrl++");
  assert.equal(canonicalKey("f13"), undefined); assert.equal(canonicalKey("ctrl+ctrl+x"), undefined);
  const safe = nativeSafe(parseConfig({ keybindings: { "editor.correct": "ctrl+s" } }).keybindings, { "app.models.save": "ctrl+s" });
  assert.deepEqual(safe.bindings["editor.correct"], []); assert.deepEqual(safe.bindings["dictation.toggle"], ["f8"]);
  assert.ok(safe.errors[0]!.includes("native control"));
});

test("selected env is per-profile; inactive credentials and unsafe metadata are never exposed", () => {
  const c = parseConfig(raw());
  c.transcription.profiles.remote!.auth = { type: "env", name: "SYNTHETIC_STT" };
  assert.equal(transcriptionKey(c.transcription.profiles.local!, { SYNTHETIC_STT: "synthetic" }), undefined);
  assert.throws(() => transcriptionKey(c.transcription.profiles.remote!, {}), ConfigError);
  const state = new ProfileSelection(); state.reset(c);
  const metadata = JSON.stringify(state.metadata()); assert.doesNotMatch(metadata, /endpoint|auth|SYNTHETIC_STT|127\.0\.0\.1/);
  assert.equal(safeLabel("bad\x1b[31m\u202esecret\n".repeat(30)).length <= 64, true);
  assert.doesNotMatch(safeLabel("bad\x1b\u202e\n"), /[\p{Cc}\p{Cf}]/u);
  assert.throws(() => state.select("standby"), ConfigError); assert.throws(() => state.select("missing"), ConfigError);
});

for (const supersede of ["select", "reselect", "reload", "save"] as const) test(`sticky publication loses to newer ${supersede}`, () => {
  const c = parseConfig(raw()), state = new ProfileSelection(); state.reset(c); const token = state.snapshot();
  if (supersede === "select") state.select("third");
  if (supersede === "reselect") state.select("local");
  if (supersede === "reload") state.reset(c);
  if (supersede === "save") { state.invalidate(); state.saved(c, state.generation); }
  assert.equal(state.publish(token, "remote"), false); assert.notEqual(state.selected, "remote");
});
test("owned success publishes process preference, failures/reset cannot publish obsolete tokens", () => {
  const c = parseConfig(raw()), state = new ProfileSelection(); state.reset(c);
  assert.equal(state.publish(state.snapshot(), "remote"), true); assert.equal(state.selected, "remote");
  const token = state.snapshot(); state.reset(); assert.equal(state.publish(token, "third"), false); assert.equal(state.selected, undefined);
  state.reset(c); state.select("third"); const generation = state.generation;
  c.transcription.order = ["remote", "local", "third"]; state.saved(c, generation);
  assert.equal(state.selected, "third"); assert.equal(state.metadata().default, "remote");
});

for (const automatic of [false, true]) test(`STT automatic=${automatic}: consent/no-wrap, fixed failure transitions`, async () => {
  const c = parseConfig(raw()); c.transcription.automaticFallback = automatic;
  const calls: string[] = [], warnings: string[] = [];
  const work = transcriptionChain(c, "remote", new AbortController().signal, async p => {
    calls.push(p.endpoint); if (p.endpoint.endsWith("remote")) throw new TranscriptionFailure("authentication failed"); return "synthetic";
  }, (a, r, b) => warnings.push(`${a}/${r}/${b}`));
  if (automatic) assert.deepEqual(await work, { text: "synthetic", profile: "third" }); else await assert.rejects(work, DictationError);
  assert.equal(calls.length, automatic ? 2 : 1); assert.ok(calls.every(c => !c.endsWith("local") && !c.endsWith("standby")));
  assert.deepEqual(warnings, automatic ? ["remote/authentication failed/third"] : []);
});
for (const reason of ["credentials unavailable", "network failure", "timeout", "throttled", "server error", "HTTP failure", "invalid response"] as const) test(`STT ${reason} advances only with consent`, async () => {
  const c = parseConfig(raw()); c.transcription.automaticFallback = true; let count = 0;
  const result = await transcriptionChain(c, "local", new AbortController().signal, async () => {
    if (++count === 1) throw new TranscriptionFailure(reason); return "synthetic";
  }); assert.equal(count, 2); assert.equal(result.profile, "remote");
});
test("shared audio failure/cancel at transition never starts next upload", async () => {
  const c = parseConfig(raw()); c.transcription.automaticFallback = true; let count = 0;
  await assert.rejects(transcriptionChain(c, "local", new AbortController().signal, async () => {
    count++; throw new DictationError("Invalid synthetic audio.");
  })); assert.equal(count, 1);
  const abort = new AbortController(); count = 0;
  await assert.rejects(transcriptionChain(c, "local", abort.signal, async () => { count++; throw new TranscriptionFailure("network failure"); }, () => abort.abort()));
  assert.equal(count, 1);
});
test("STT deadline and cancelled uncooperative attempt settle without another request/warning", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = parseConfig(raw()); c.transcription.automaticFallback = true; c.transcription.totalTimeoutSeconds = 1;
  let count = 0, warnings = 0;
  const work = transcriptionChain(c, "local", new AbortController().signal, () => { count++; return new Promise(() => {}); }, () => warnings++);
  await nextTask(); t.mock.timers.tick(1000); await assert.rejects(work);
  assert.equal(count, 1); assert.equal(warnings, 0);
  const abort = new AbortController(); c.transcription.totalTimeoutSeconds = 120;
  const cancelled = transcriptionChain(c, "local", abort.signal, () => new Promise(() => {}));
  await nextTask(); abort.abort(); await assert.rejects(cancelled);
});
test("serialized source/profile saves preserve fields, inactive definitions and relative order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-save-v02-"));
  try {
    const store = new ConfigStore(dir), original = { ...raw(), delivery: { dictationMarker: true } };
    await writeFile(store.path, JSON.stringify(original)); store.setSource("synthetic-source");
    await Promise.all([store.saveProfile("third"), store.saveSource(), store.saveProfile("remote")]);
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    assert.deepEqual(saved.transcription.order, ["remote", "third", "local"]);
    assert.deepEqual(saved.transcription.profiles, original.transcription.profiles);
    assert.deepEqual(saved.delivery, original.delivery); assert.equal(saved.recorder.source, "synthetic-source");
    assert.equal((await stat(store.path)).mode & 0o077, 0);
    await assert.rejects(store.saveProfile("standby")); await assert.rejects(store.saveProfile("missing"));
    assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), saved);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("expired transcription-entry budget never uploads after audio preparation", async () => {
  let attempts = 0;
  await assert.rejects(transcriptionChain(parseConfig(raw()), "local", new AbortController().signal,
    async () => { attempts++; return "synthetic"; }, undefined, performance.now() - 1));
  assert.equal(attempts, 0);
});

test("editor ownership lost at STT completion prevents next upload before a UI timer", async () => {
  const c = parseConfig(raw()); c.transcription.automaticFallback = true; let owned = true, attempts = 0, warnings = 0;
  await assert.rejects(transcriptionChain(c, "local", new AbortController().signal, async () => {
    attempts++; owned = false; throw new TranscriptionFailure("network failure");
  }, () => warnings++, undefined, () => owned));
  assert.equal(attempts, 1); assert.equal(warnings, 0);
});
