/**
 * Purpose: Verify remembered correction choices, explicit saves and newer-choice races.
 * Strategy: Use synthetic settings only; never contact a provider.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.2
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CorrectionSelection, correctionCandidates } from "../src/correction-selection.ts";
import { ConfigStore, parseConfig, ConfigError } from "../src/config.ts";

const settings = () => parseConfig({ correction: {
  order: ["fixture/one", "$current", "fixture/three"],
  modelSettings: { "fixture/inactive": { thinkingLevel: null } },
} });

test("correction choice starts at the first entry and remembers only an ordered winner", () => {
  const config = settings(), choice = new CorrectionSelection();
  choice.reset(config);
  assert.equal(choice.selected, "fixture/one");
  assert.equal(choice.publish(choice.snapshot(), "$current"), true);
  assert.equal(choice.selected, "$current");
  assert.deepEqual(correctionCandidates(config, choice.selected), ["$current", "fixture/three"]);
  assert.deepEqual(choice.metadata(config).order, ["fixture/one", "$current", "fixture/three"]);
  assert.deepEqual(config.correction.order, ["fixture/one", "$current", "fixture/three"]);
  assert.equal(choice.publish(choice.snapshot(), "fixture/inactive"), false);
  assert.throws(() => choice.select("fixture/inactive"), ConfigError);
  assert.throws(() => choice.select("fixture/missing"), ConfigError);
});

for (const newer of ["choice", "reselection", "reload", "save", "failed reload"] as const) {
  test(`held correction success loses to newer ${newer}`, () => {
    const config = settings(), choice = new CorrectionSelection();
    choice.reset(config);
    const token = choice.snapshot();
    if (newer === "choice") choice.select("fixture/three");
    if (newer === "reselection") choice.select("fixture/one");
    if (newer === "reload") { choice.invalidate(); choice.reset(config); }
    if (newer === "failed reload") { choice.invalidate(); choice.reset(); }
    if (newer === "save") { choice.invalidate(); choice.saved(config, choice.generation); }
    assert.equal(choice.publish(token, "$current"), false);
    assert.notEqual(choice.selected, "$current");
  });
}

test("earlier save preserves a newer temporary correction choice", () => {
  const config = settings(), choice = new CorrectionSelection();
  choice.reset(config); choice.select("$current"); choice.invalidate();
  const generation = choice.generation;
  choice.select("fixture/three");
  const saved = settings(); saved.correction.order = ["$current", "fixture/one", "fixture/three"];
  choice.saved(saved, generation);
  assert.equal(choice.selected, "fixture/three");
  assert.equal(choice.metadata(saved).default, "$current");
  choice.reset(saved); assert.equal(choice.selected, "$current");
});

test("removed entries reset the correction choice; empty and unknown orders never authorize models", () => {
  const choice = new CorrectionSelection(), config = settings();
  choice.reset(config); choice.select("fixture/three");
  config.correction.order = ["fixture/one"];
  choice.saved(config, choice.generation); assert.equal(choice.selected, "fixture/one");
  choice.reset(parseConfig({}));
  assert.equal(choice.selected, undefined);
  assert.deepEqual(correctionCandidates(parseConfig({})), []);
  assert.deepEqual(correctionCandidates(settings(), "fixture/inactive"), []);
  assert.equal(choice.publish(choice.snapshot(), "fixture/one"), false);
});

test("correction listing returns policy only and cannot change its internal order", () => {
  const config = settings(), choice = new CorrectionSelection(); choice.reset(config);
  const metadata = choice.metadata(config);
  assert.doesNotMatch(JSON.stringify(metadata), /endpoint|auth|thinking|temperature|fixture\/inactive/);
  metadata.order.splice(0);
  assert.equal(choice.metadata(config).order.length, 3);
});

test("serialized correction/profile/source saves preserve other settings and inactive tuning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-correction-save-"));
  try {
    const store = new ConfigStore(dir);
    const original = {
      correction: { order: ["fixture/one", "$current", "fixture/three", "$current"],
        automatic: false, modelSettings: { "fixture/inactive": { temperature: 0.5 } }, context: { maxChars: 0 } },
      transcription: { order: ["local", "remote"], profiles: Object.fromEntries(["local", "remote"].map(name => [name,
        { endpoint: `http://127.0.0.1:1/${name}`, model: "synthetic", auth: { type: "none" } }])) },
      delivery: { dictationMarker: true },
    };
    await writeFile(store.path, JSON.stringify(original));
    store.setSource("synthetic-source");
    await Promise.all([store.saveCorrectionModel("$current"), store.saveProfile("remote"), store.saveSource()]);
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    assert.deepEqual(saved.correction, { ...original.correction, order: ["$current", "fixture/one", "fixture/three"] });
    assert.deepEqual(saved.transcription, { ...original.transcription, order: ["remote", "local"] });
    assert.deepEqual(saved.delivery, original.delivery);
    assert.equal(saved.recorder.source, "synthetic-source");
    assert.equal((await stat(store.path)).mode & 0o077, 0);
    for (const name of ["fixture/inactive", "fixture/missing"]) await assert.rejects(store.saveCorrectionModel(name), ConfigError);
    assert.deepEqual(JSON.parse(await readFile(store.path, "utf8")), saved);
    assert.deepEqual(await readdir(dir), ["pi-oaistt.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("correction save cannot activate an empty order or overwrite invalid live edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-correction-invalid-"));
  try {
    const store = new ConfigStore(dir);
    await assert.rejects(store.saveCorrectionModel("$current"), ConfigError);
    assert.deepEqual(await readdir(dir), []);
    await writeFile(store.path, JSON.stringify({ correction: { unknown: "SYNTHETIC_SECRET" } }));
    const before = await readFile(store.path, "utf8");
    await assert.rejects(store.saveCorrectionModel("fixture/one"), error => error instanceof ConfigError && !error.message.includes("SYNTHETIC_SECRET"));
    assert.equal(await readFile(store.path, "utf8"), before);
    assert.deepEqual(await readdir(dir), ["pi-oaistt.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
