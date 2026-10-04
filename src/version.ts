/**
 * Purpose: identify the loaded installation without borrowing a parent repository.
 * Strategy: read its package version and optionally query only its own Git metadata.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-04
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export interface InstallationIdentity { version?: string; commit?: string }
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const execute = promisify(execFile);

async function checkoutHead(root: string): Promise<string> {
  // Do not inherit repository overrides, trace output or global Git configuration.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
  const { stdout } = await execute("git", ["--no-optional-locks", "-C", root, "--git-dir", join(root, ".git"), "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8", timeout: 500, killSignal: "SIGKILL", maxBuffer: 4096,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

/** Called once from interactive session_start, never on import or each status. */
export async function loadInstallationIdentity(
  root = fileURLToPath(new URL("../", import.meta.url)),
  git: (root: string) => Promise<string> = checkoutHead,
): Promise<InstallationIdentity> {
  const identity: InstallationIdentity = {};
  try {
    root = await realpath(root); // Includes Pi's symlinked local installations.
    const manifest = join(root, "package.json");
    const info = await lstat(manifest);
    if (!info.isFile() || info.size > 64 * 1024) return identity;
    const pkg: unknown = JSON.parse(await readFile(manifest, "utf8"));
    if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "pi-oaistt" || !("version" in pkg)
      || typeof pkg.version !== "string" || pkg.version.length > 64 || !semver.test(pkg.version)) return identity;
    identity.version = pkg.version;
  } catch { return identity; }
  try {
    const metadata = await lstat(join(root, ".git"));
    // A Git directory or worktree gitfile must belong to this package root.
    // Missing metadata must not trigger upward discovery of the project/Pi repo.
    if (!metadata.isDirectory() && !metadata.isFile()) return identity;
    const head = (await git(root)).trim();
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) identity.commit = head.slice(0, 7);
  } catch { /* Optional Git: missing tool, empty/broken repo and timeout are silent. */ }
  return identity;
}

export function installationLabel(identity: InstallationIdentity): string {
  const version = identity.version && identity.version.length <= 64 && semver.test(identity.version) ? identity.version : undefined;
  const commit = identity.commit && /^[0-9a-f]{7}$/u.test(identity.commit) ? identity.commit : undefined;
  return `oaistt${version ? ` v${version}${commit ? ` (${commit})` : ""}` : ""}`;
}
