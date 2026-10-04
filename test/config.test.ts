/**
 * pi-oaistt config tests
 *
 * Purpose: verify config behavior without real audio, credentials or provider calls.
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
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, ConfigStore, configSnapshot, parseConfig, transcriptionKey } from "../src/config.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function store() {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-config-test-"));
  dirs.push(dir);
  return { dir, store: new ConfigStore(dir) };
}

test("missing settings use documented defaults, no implicit correction model", () => {
  const config = parseConfig({});
  assert.equal(config.recorder.backend, "parecord");
  assert.equal(config.recorder.source, null);
  assert.equal(config.recorder.maxDurationSeconds, 300);
  assert.equal(config.transcription.profiles.openai!.endpoint, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(config.transcription.profiles.openai!.model, "whisper-1");
  assert.deepEqual(config.transcription.profiles.openai!.auth, { type: "env", name: "OPENAI_API_KEY" });
  assert.equal(config.correction.automatic, true);
  assert.deepEqual(config.correction.order, []);
  assert.equal(config.correction.context.maxChars, 8000);
});

test("snapshot is independent and deeply frozen", () => {
  const config = parseConfig({ correction: { order: ["local/model", "remote/model"] } });
  const snapshot = configSnapshot(config);
  config.correction.order.reverse();
  config.recorder.source = "later-source";
  assert.deepEqual(snapshot.correction.order, ["local/model", "remote/model"]);
  assert.equal(snapshot.recorder.source, null);
  assert.throws(() => snapshot.correction.order.push("unlisted/model"), TypeError);
  assert.throws(() => { snapshot.correction.context.maxChars = 0; }, TypeError);
});

test("explicit compatible/local endpoint, null auth and disabled context/correction", () => {
  const config = parseConfig({ transcription: { order: ["openai"], profiles: { openai: { endpoint: "http://127.0.0.1:9000/v1/audio/transcriptions", model: "local-stt", auth: { type: "none" }, language: "de" } } }, correction: { automatic: false, context: { maxChars: 0 } } });
  assert.equal(transcriptionKey(config.transcription.profiles.openai!, {}), undefined);
  assert.equal(config.correction.context.maxChars, 0);
  assert.equal(config.correction.automatic, false);
  assert.equal(config.transcription.profiles.openai!.model, "local-stt");
});

for (const value of [
  null, [], { extra: true }, { recorder: null }, { transcription: [] },
  { recorder: { backend: "auto" } }, { recorder: { source: "bad\nsource" } },
  { recorder: { maxDurationSeconds: 0 } }, { recorder: { stopTimeoutSeconds: 1.5 } },
  { recorder: { maxBytes: Number.MAX_SAFE_INTEGER } },
  { transcription: { order: ["openai"], profiles: { openai: { endpoint: "not-a-url", model: "whisper-1", auth: { type: "env", name: "OPENAI_API_KEY" } } } } },
  { transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://synthetic:secret@example.invalid/stt", model: "whisper-1", auth: { type: "env", name: "OPENAI_API_KEY" } } } } },
  { transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://example.invalid/stt?key=synthetic", model: "whisper-1", auth: { type: "env", name: "OPENAI_API_KEY" } } } } },
  { transcription: { order: ["openai"], profiles: { openai: { endpoint: "file:///synthetic", model: "whisper-1", auth: { type: "env", name: "OPENAI_API_KEY" } } } } },
  { transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "", auth: { type: "env", name: "OPENAI_API_KEY" } } } } }, { transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", auth: { type: "env", name: "OPENAI_API_KEY" }, language: "" } } } },
  { transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", auth: { type: "env", name: "!synthetic-command" } } } } },
  { transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", auth: { type: "env", name: "OPENAI_API_KEY" }, attemptTimeoutSeconds: null } } } },
  { correction: { automatic: "false" } }, { correction: { order: ["$unknown"] } },
  { correction: { order: ["provider/"] } }, { correction: { order: [12] } },
  { correction: { context: { maxChars: -1 } } }, { correction: { context: { maxChars: 1.5 } } },
  { correction: { context: { unknown: 2 } } }, { correction: { timeout: 30 } },
]) {
  test(`invalid configuration rejects, never silently reroutes: ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseConfig(value), ConfigError);
  });
}

test("credential resolution uses only selected env and does not echo values", () => {
  const config = parseConfig({ transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", auth: { type: "env", name: "FIXTURE_STT_KEY" } } } } });
  assert.equal(transcriptionKey(config.transcription.profiles.openai!, { FIXTURE_STT_KEY: "synthetic-test-value" }), "synthetic-test-value");
  assert.throws(() => transcriptionKey(config.transcription.profiles.openai!, { OPENAI_API_KEY: "unselected-synthetic" }), /credential unavailable/);
  assert.throws(() => transcriptionKey(config.transcription.profiles.openai!, { FIXTURE_STT_KEY: "synthetic\nvalue" }), (error: unknown) =>
    error instanceof ConfigError && !error.message.includes("synthetic"));
});

test("temporary source adjustment never writes, explicit save changes source only", async () => {
  const { dir, store: config } = await store();
  const original = { transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "explicit-fixture-model", auth: { type: "env", name: "OPENAI_API_KEY" } } } }, correction: { automatic: false } };
  await writeFile(config.path, JSON.stringify(original));
  const first = await config.load();
  config.setSource("fixture-input");
  assert.equal((await config.load()).recorder.source, "fixture-input");
  assert.equal(first.recorder.source, null);
  assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), original);
  await config.saveSource();
  assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { ...original, recorder: { source: "fixture-input" } });
  assert.equal((await stat(config.path)).mode & 0o077, 0);
  assert.deepEqual(await readdir(dir), ["pi-oaistt.json"]);
  config.setSource(null);
  await config.saveSource();
  assert.equal((await new ConfigStore(dir).load()).recorder.source, null);
});

test("missing file/list creates no config until explicit source save", async () => {
  const { dir, store: config } = await store();
  assert.deepEqual((await config.load()).correction.order, []);
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(config.saveSource(), /No temporary source/);
  config.setSource("fixture-input");
  await config.saveSource();
  assert.deepEqual(JSON.parse(await readFile(config.path, "utf8")), { recorder: { source: "fixture-input" } });
});

test("live edits to other fields are preserved on save", async () => {
  const { store: config } = await store();
  await config.load();
  config.setSource("fixture-input");
  await writeFile(config.path, JSON.stringify({ correction: { order: ["fixture/new-model"] } }));
  await config.saveSource();
  assert.deepEqual((await config.load()).correction.order, ["fixture/new-model"]);
});

test("invalid JSON or field fails without source saving or secret disclosure", async () => {
  const { dir, store: config } = await store();
  const invalid = "invalid-synthetic-secret-json";
  await writeFile(config.path, invalid);
  config.setSource("fixture-input");
  await assert.rejects(config.load(), (error: unknown) =>
    error instanceof ConfigError && !error.message.includes(invalid));
  await assert.rejects(config.saveSource(), ConfigError);
  assert.equal(await readFile(config.path, "utf8"), invalid);
  assert.deepEqual(await readdir(dir), ["pi-oaistt.json"]);
});

test("symlinked and oversized configs rejected without modifying targets", async () => {
  const { dir, store: config } = await store();
  const target = join(dir, "target.json");
  await writeFile(target, "{}");
  await symlink(target, config.path);
  await assert.rejects(config.load(), ConfigError);
  config.setSource("fixture-input");
  await assert.rejects(config.saveSource(), ConfigError);
  assert.equal(await readFile(target, "utf8"), "{}");
  await rm(config.path);
  await writeFile(config.path, " ".repeat(65537));
  await assert.rejects(config.load(), ConfigError);
});

for (const enabled of [true, false, "SYNTHETIC_SECRET", null]) test(`unknown correction field is rejected without exposing values (${typeof enabled})`, () => {
  assert.throws(() => parseConfig({ correction: { enabled } }), (error: unknown) =>
    error instanceof ConfigError && /correction fields/.test(error.message) &&
    error.message.includes("docs/configuration.md") && !error.message.includes("SYNTHETIC_SECRET"));
});
test("unknown fields are rejected even alongside supported fields", () => {
  assert.throws(() => parseConfig({ correction: { enabled: true, automatic: false } }), /correction fields/);
});
for (const value of [null, 0, "true", []]) test(`automatic requires a boolean (${JSON.stringify(value)})`, () => {
  assert.throws(() => parseConfig({ correction: { automatic: value } }), /correction\.automatic/);
});
test("unknown configuration fields prevent load/save without rewriting the file", async () => {
  const { dir, store: config } = await store();
  const bytes = JSON.stringify({ correction: { enabled: false, order: ["fixture/one"] } });
  await writeFile(config.path, bytes);
  await assert.rejects(config.load(), /correction fields/);
  config.setSource("synthetic-input"); await assert.rejects(config.saveSource(), /correction fields/);
  assert.equal(await readFile(config.path, "utf8"), bytes);
  assert.deepEqual(await readdir(dir), ["pi-oaistt.json"]);
});

test("documented JSON examples parse; defaults stay empty and recommendation requires explicit choice", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const reference = await readFile(new URL("../docs/configuration.md", import.meta.url), "utf8");
  const examples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]!));
  for (const text of [readme, reference]) for (const m of text.matchAll(/```json\n([\s\S]*?)\n```/g)) parseConfig(JSON.parse(m[1]!));
  const defaults = readme.slice(readme.indexOf("### Full configuration and defaults")).match(/```json\n([\s\S]*?)\n```/)![1]!;
  assert.deepEqual(parseConfig(JSON.parse(defaults)), parseConfig({}));
  assert.equal(parseConfig({}).correction.automatic, true); assert.deepEqual(parseConfig({}).correction.order, []);
  const recommendation = examples.find(e => e.correction?.order?.includes("openai-codex/gpt-6.1-luna"));
  assert.ok(recommendation); assert.equal(parseConfig(recommendation).correction.automatic, true);
  assert.equal(recommendation.correction.order[0], "openai-codex/gpt-6.1-luna");
  assert.deepEqual(parseConfig(recommendation).correction.order, recommendation.correction.order);
  const explicitOther = parseConfig({ correction: { order: ["fixture/one"], modelSettings: { "openai-codex/gpt-6.1-luna": {} } } });
  assert.deepEqual(explicitOther.correction.order, ["fixture/one"]);
});
