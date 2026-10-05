/**
 * pi-oaistt loader tests
 *
 * Purpose: verify loader behavior without real audio, credentials or provider calls.
 * Strategy: combine synthetic inputs and controlled failures with relevant real APIs.
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
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createPiUI } from "./pi-ui-fixture.ts";
import { loadInstallationIdentity, installationLabel } from "../src/version.ts";

test("real Pi discovery/jiti/runner loads symlinked directory, exposes commands and restores editor on shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-load-test-"));
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const native = createPiUI();
  try {
    const agentDir = join(dir, "agent");
    await mkdir(agentDir);
    // Entirely synthetic config; never load the user's actual agent config.
    await writeFile(join(agentDir, "pi-oaistt.json"), JSON.stringify({ transcription: { order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", auth: { type: "none" } } } }, correction: { automatic: false } }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const extensions = join(dir, ".pi", "extensions"); await mkdir(extensions, { recursive: true });
    const product = resolve(fileURLToPath(new URL("..", import.meta.url)));
    await symlink(product, join(extensions, "pi-oaistt"));
    const loaded = await discoverAndLoadExtensions([], dir, agentDir);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, dir, SessionManager.inMemory(dir), new ModelRegistry(runtime));
    const notices: string[] = [];
    runner.setUIContext({ ...native.ui, notify: (message) => { notices.push(message); }, setStatus: () => {}, setWidget: () => {} }, "tui");
    const command = runner.getCommand("oaistt"); assert.ok(command);
    await runner.emit({ type: "session_start", reason: "startup" });
    assert.ok(runner.getShortcuts({}).has("f8"));
    assert.ok(native.ui.getEditorComponent());
    await command.handler("help", runner.createCommandContext());
    await command.handler("status", runner.createCommandContext());
    assert.ok(notices.some(text => text.replace(/\x1b\[[0-9;]*m/g, "").includes("oaistt — speech to text · F8 to dictate · F7 to correct · F12 to cancel · see /oaistt help")));
    assert.ok(notices.some((text) => text.replace(/\x1b\[[0-9;]*m/g, "").includes("Configuration loaded successfully")));
    const installed = await loadInstallationIdentity(product);
    assert.equal(installed.version, "0.2.0");
    assert.ok(notices.some(text => text.replace(/\x1b\[[0-9;]*m/g, "").includes(`${installationLabel(installed)}: idle.`)));
    native.ui.setEditorText("synthetic retained draft");
    await command.handler("recorder source", runner.createCommandContext());
    assert.equal(native.mode.extensionInput, undefined);
    native.ui.pasteToEditor("synthetic pasted line\n".repeat(15));
    const semantic = native.ui.getEditorText();
    assert.match(native.mode.editor.getLines().join("\n"), /\[paste #/);
    native.mode.resetExtensionUI(); // Real Pi does this BEFORE shutdown.
    assert.equal(native.ui.getEditorText(), semantic);
    await runner.emit({ type: "session_shutdown", reason: "reload" });
    assert.equal(native.ui.getEditorComponent(), undefined);
    runner.invalidate();
    assert.equal(native.ui.getEditorText(), semantic);
    assert.equal(notices.some(text => text.includes("source changed")), false);
    await writeFile(join(agentDir, "pi-oaistt.json"), JSON.stringify({ keybindings: { "dictation.toggle": [], "editor.correct": "f6", "operation.cancel": [] } }));
    const fresh = await discoverAndLoadExtensions([], dir, agentDir);
    assert.deepEqual(fresh.errors, []);
    const next = new ExtensionRunner(fresh.extensions, fresh.runtime, dir, SessionManager.inMemory(dir), new ModelRegistry(runtime));
    const nextUI = { ...native.ui, notify: (message: string) => notices.push(message), setStatus: () => {}, setWidget: () => {} };
    next.setUIContext(nextUI, "tui");
    native.mode.createExtensionUIContext = () => nextUI;
    await next.emit({ type: "session_start", reason: "reload" });
    assert.deepEqual([...next.getShortcuts({}).keys()], ["f6"]);
    Object.assign(native.session, { agent: { signal: new AbortController().signal } });
    native.mode.setupExtensionShortcuts(next);
    assert.equal(native.mode.defaultEditor.onExtensionShortcut?.("\x1b[19~"), false);
    assert.equal(native.mode.defaultEditor.onExtensionShortcut?.("\x1b[18~"), false);
    native.ui.setEditorText("");
    assert.equal(native.mode.defaultEditor.onExtensionShortcut?.("\x1b[17~"), true);
    await nextTask(); assert.ok(notices.some(n => n.includes("Nothing to correct")));
    await next.emit({ type: "session_shutdown", reason: "quit" }); next.invalidate();
  } finally {
    native.stop();
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    await rm(dir, { recursive: true, force: true });
  }
});
