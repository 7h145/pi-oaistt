import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createPiUI } from "./pi-ui-fixture.ts";

test("real Pi discovery/jiti/runner loads symlinked directory, exposes commands and restores editor on shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-load-test-"));
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const native = createPiUI();
  try {
    const agentDir = join(dir, "agent");
    await mkdir(agentDir);
    // Entirely synthetic config; never load the user's actual agent config.
    await writeFile(join(agentDir, "pi-oaistt.json"), JSON.stringify({ transcription: { apiKeyEnv: null }, correction: { enabled: false } }));
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
    assert.ok(runner.getShortcuts({}).has("f8"));
    await runner.emit({ type: "session_start", reason: "startup" });
    assert.ok(native.ui.getEditorComponent());
    await command.handler("help", runner.createCommandContext());
    await command.handler("status", runner.createCommandContext());
    assert.ok(notices.some((text) => text.includes("pi-oaistt ready")));
    assert.ok(notices.some((text) => text.includes("F8 or /oaistt")));
    assert.ok(notices.some((text) => text.includes("Config: ready")));
    await runner.emit({ type: "session_shutdown", reason: "reload" });
    assert.equal(native.ui.getEditorComponent(), undefined);
    runner.invalidate();
  } finally {
    native.stop();
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    await rm(dir, { recursive: true, force: true });
  }
});
