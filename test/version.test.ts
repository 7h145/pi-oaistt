/**
 * Purpose: verify installed-version metadata without personal repositories or config.
 * Strategy: synthetic packages, optional Git stubs and isolated local Git fixtures.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-04
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadInstallationIdentity, installationLabel } from "../src/version.ts";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(version: unknown = "0.2.0") {
  const parent = await mkdtemp(join(tmpdir(), "oaistt-version-")); paths.push(parent);
  const root = join(parent, "installed package"); await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-oaistt", version }));
  return { parent, root };
}

test("npm/non-Git package uses package version without searching a parent repository", async () => {
  const h = await fixture(); await mkdir(join(h.parent, ".git"));
  let calls = 0;
  assert.deepEqual(await loadInstallationIdentity(h.root, async () => { calls++; return "a".repeat(40); }), { version: "0.2.0" });
  assert.equal(calls, 0);
  assert.equal(installationLabel({ version: "0.2.0" }), "oaistt v0.2.0");
});

for (const length of [40, 64]) for (const gitfile of [false, true]) test(`own Git metadata, hash length=${length}, gitfile=${gitfile}`, async () => {
  const h = await fixture("0.2.1-rc.1+synthetic");
  if (gitfile) await writeFile(join(h.root, ".git"), "gitdir: /synthetic/worktree\n");
  else await mkdir(join(h.root, ".git"));
  const identity = await loadInstallationIdentity(h.root, async root => { assert.equal(root, h.root); return `${"1234abc"}${"d".repeat(length - 7)}\n`; });
  assert.deepEqual(identity, { version: "0.2.1-rc.1+synthetic", commit: "1234abc" });
  assert.equal(installationLabel(identity), "oaistt v0.2.1-rc.1+synthetic (1234abc)");
});

test("symlinked package resolves its installation rather than the link's parent", async () => {
  const h = await fixture(); await mkdir(join(h.root, ".git"));
  const link = join(h.parent, "link"); await symlink(h.root, link);
  assert.deepEqual(await loadInstallationIdentity(link, async root => { assert.equal(root, h.root); return "a".repeat(40); }),
    { version: "0.2.0", commit: "aaaaaaa" });
});

for (const output of ["", "1234abc", "EXCLUDED_SYNTHETIC_DIAGNOSTICS", `${"a".repeat(40)}\n${"b".repeat(40)}`]) {
  test("invalid Git output is omitted rather than displayed", async () => {
    const h = await fixture(); await mkdir(join(h.root, ".git"));
    assert.deepEqual(await loadInstallationIdentity(h.root, async () => output), { version: "0.2.0" });
  });
}

test("missing Git, failed checkout or timeout silently leaves version-only metadata", async () => {
  const h = await fixture(); await mkdir(join(h.root, ".git"));
  assert.deepEqual(await loadInstallationIdentity(h.root, async () => { throw new Error("EXCLUDED_SYNTHETIC_DIAGNOSTICS"); }), { version: "0.2.0" });
});

for (const version of [null, 2, "EXCLUDED_SYNTHETIC_VERSION", "0.2.0\n", `0.2.0-${"x".repeat(64)}`]) {
  test("malformed package version cannot emit arbitrary content or query Git", async () => {
    const h = await fixture(version); await mkdir(join(h.root, ".git"));
    assert.deepEqual(await loadInstallationIdentity(h.root, async () => { throw new Error("must not query Git"); }), {});
  });
}

for (const bytes of ["{", JSON.stringify({ name: "other-package", version: "1.0.0" }), " ".repeat(65537)]) {
  test("broken, unrelated or oversized manifest is optional metadata failure", async () => {
    const h = await fixture(); await writeFile(join(h.root, "package.json"), bytes);
    assert.deepEqual(await loadInstallationIdentity(h.root), {});
  });
}

test("missing package metadata and unsafe formatter values degrade without guessed identity", async () => {
  const h = await fixture(); await rm(join(h.root, "package.json"));
  assert.deepEqual(await loadInstallationIdentity(h.root), {});
  assert.equal(installationLabel({}), "oaistt");
  assert.equal(installationLabel({ version: "0.2.0\nEXCLUDED", commit: "1234abc" }), "oaistt");
  assert.equal(installationLabel({ version: "0.2.0", commit: "EXCLUDED" }), "oaistt v0.2.0");
});

test("real Git fixture resolves package HEAD and a worktree gitfile, ignoring ambient repository overrides", async () => {
  const h = await fixture();
  const execute = promisify(execFile);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key))),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]) => execute("git", ["-C", h.root, ...args], { env, timeout: 2000 });
  await git(["init", "--quiet"]);
  await git(["add", "package.json"]);
  await git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "synthetic fixture"]);
  const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
  try {
    process.env.GIT_DIR = join(h.parent, "unrelated"); process.env.GIT_WORK_TREE = h.parent;
    process.env.GIT_COMMON_DIR = join(h.parent, "unrelated");
    assert.deepEqual(await loadInstallationIdentity(h.root), { version: "0.2.0", commit: head.slice(0, 7) });
    const worktree = join(h.parent, "worktree");
    await git(["worktree", "add", "--quiet", "--detach", worktree]);
    assert.deepEqual(await loadInstallationIdentity(worktree), { version: "0.2.0", commit: head.slice(0, 7) });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("unresponsive Git client is bounded and never blocks version-only fallback", async () => {
  const h = await fixture(); await mkdir(join(h.root, ".git"));
  const bin = join(h.parent, "bin"); await mkdir(bin);
  await writeFile(join(bin, "git"), `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const saved = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.deepEqual(await loadInstallationIdentity(h.root), { version: "0.2.0" });
  } finally { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; }
});
