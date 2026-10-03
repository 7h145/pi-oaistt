/**
 * pi-oaistt configuration
 *
 * Purpose: validate settings and resolve explicit credential/source policies.
 * Strategy: use data-only defaults, frozen snapshots and opt-in atomic source saves.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { parseBindings, type Bindings } from "./keys.ts";

export type Thinking = ModelThinkingLevel | null | { invalid: true };
export interface ModelSettings { thinkingLevel: Thinking; attemptTimeoutSeconds: number }
export interface Profile {
  endpoint: string; model: string;
  auth: { type: "none" } | { type: "env"; name: string };
  language: string | null; attemptTimeoutSeconds: number;
}
export interface Config {
  recorder: { backend: "parecord"; source: string | null; maxDurationSeconds: number; maxBytes: number; stopTimeoutSeconds: number };
  transcription: { order: string[]; profiles: Record<string, Profile>; automaticFallback: boolean; totalTimeoutSeconds: number };
  correction: { enabled: boolean; order: string[]; defaults: ModelSettings; modelSettings: Record<string, ModelSettings>;
    context: { maxChars: number }; totalTimeoutSeconds: number };
  delivery: { dictationMarker: boolean };
  keybindings: Bindings;
  keyErrors: string[];
}
export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}
function fail(field: string): never {
  throw new ConfigError(`Invalid pi-oaistt configuration: ${field}. Use the v0.2 order/maps schema; see migration documentation.`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${field} fields`);
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(value)) fail(field);
  return value;
}
function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(field);
  return value;
}
function seconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 3600) fail(field);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field);
  return value;
}
const fallback = (value: unknown, other: unknown): unknown => value === undefined ? other : value;
function language(value: unknown): string | null {
  if (value === null) return null;
  const s = string(value, "transcription.language");
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(s)) fail("transcription.language");
  return s;
}
function thinking(value: unknown): Thinking {
  if (value === null) return null;
  if (typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) return value as ModelThinkingLevel;
  return { invalid: true }; // Retain a reportable fault, NEVER silently become null.
}
function modelId(value: unknown): string {
  const s = string(value, "correction model identity");
  if (!/^[^/\s]+\/\S+$/u.test(s) || s.startsWith("$")) fail("correction model identity");
  return s;
}
export function profileName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value)) fail("transcription profile name");
  return value;
}
function tuning(raw: Record<string, unknown>, defaults: ModelSettings): ModelSettings {
  keys(raw, ["thinkingLevel", "attemptTimeoutSeconds"], "correction tuning");
  return { thinkingLevel: raw.thinkingLevel === undefined ? defaults.thinkingLevel : thinking(raw.thinkingLevel),
    attemptTimeoutSeconds: seconds(fallback(raw.attemptTimeoutSeconds, defaults.attemptTimeoutSeconds), "correction.attemptTimeoutSeconds") };
}

/** Strict public file schema; effective maps have resolved tuning, never credentials. */
export function parseConfig(value: unknown): Config {
  const root = object(value, "root");
  keys(root, ["recorder", "transcription", "correction", "delivery", "keybindings"], "root");
  const r = object(fallback(root.recorder, {}), "recorder");
  keys(r, ["backend", "source", "maxDurationSeconds", "maxBytes", "stopTimeoutSeconds"], "recorder");
  if (fallback(r.backend, "parecord") !== "parecord") fail("recorder.backend (supported: parecord)");
  const source = r.source === null || r.source === undefined ? null : string(r.source, "recorder.source");
  if (source !== null && source.length > 512) fail("recorder.source");
  const t = object(fallback(root.transcription, {
    order: ["openai"], profiles: { openai: { endpoint: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1", auth: { type: "env", name: "OPENAI_API_KEY" } } },
  }), "transcription");
  keys(t, ["order", "profiles", "defaults", "automaticFallback", "totalTimeoutSeconds"], "transcription");
  const td = object(fallback(t.defaults, {}), "transcription.defaults");
  keys(td, ["language", "attemptTimeoutSeconds"], "transcription.defaults");
  const defaultLanguage = language(fallback(td.language, null));
  const defaultTimeout = seconds(fallback(td.attemptTimeoutSeconds, 60), "transcription.defaults.attemptTimeoutSeconds");
  const definitions = object(t.profiles, "transcription.profiles");
  if (Object.keys(definitions).length > 32) fail("transcription.profiles (at most 32)");
  const profiles: Record<string, Profile> = Object.create(null);
  for (const [name, definition] of Object.entries(definitions)) {
    profileName(name);
    const p = object(definition, "transcription.profiles.entry");
    keys(p, ["endpoint", "model", "auth", "language", "attemptTimeoutSeconds"], "transcription.profiles.entry");
    const endpoint = string(p.endpoint, "transcription.profiles.endpoint");
    try { const url = new URL(endpoint);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) fail("transcription.profiles.endpoint");
    } catch { fail("transcription.profiles.endpoint (HTTP(S), no userinfo/query/fragment)"); }
    const a = object(p.auth, "transcription.profiles.auth");
    let auth: Profile["auth"];
    if (a.type === "none") { keys(a, ["type"], "transcription.profiles.auth"); auth = { type: "none" }; }
    else if (a.type === "env") {
      keys(a, ["type", "name"], "transcription.profiles.auth");
      const name = string(a.name, "transcription.profiles.auth.name");
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) fail("transcription.profiles.auth.name");
      auth = { type: "env", name };
    } else fail("transcription.profiles.auth.type");
    profiles[name] = { endpoint, model: string(p.model, "transcription.profiles.model"), auth,
      language: p.language === undefined ? defaultLanguage : language(p.language),
      attemptTimeoutSeconds: seconds(fallback(p.attemptTimeoutSeconds, defaultTimeout), "transcription.profiles.attemptTimeoutSeconds") };
  }
  if (!Array.isArray(t.order) || !t.order.length || t.order.length > 32) fail("transcription.order");
  const order = t.order.map(profileName);
  if (new Set(order).size !== order.length || order.some(name => !Object.hasOwn(profiles, name))) fail("transcription.order references/duplicates");
  const c = object(fallback(root.correction, {}), "correction");
  keys(c, ["enabled", "order", "modelSettings", "defaults", "context", "totalTimeoutSeconds"], "correction");
  const cd = tuning(object(fallback(c.defaults, {}), "correction.defaults"), { thinkingLevel: null, attemptTimeoutSeconds: 15 });
  const settings = object(fallback(c.modelSettings, {}), "correction.modelSettings");
  if (Object.keys(settings).length > 32) fail("correction.modelSettings (at most 32)");
  const modelSettings: Record<string, ModelSettings> = Object.create(null);
  for (const [name, setting] of Object.entries(settings)) modelSettings[modelId(name)] = tuning(object(setting, "correction.modelSettings.entry"), cd);
  const selectors = fallback(c.order, []);
  if (!Array.isArray(selectors) || selectors.length > 32) fail("correction.order");
  const correctionOrder = selectors.map(s => s === "$current" ? s : modelId(s));
  const context = object(fallback(c.context, {}), "correction.context"); keys(context, ["maxChars"], "correction.context");
  const d = object(fallback(root.delivery, {}), "delivery"); keys(d, ["dictationMarker"], "delivery");
  const bindings = parseBindings(root.keybindings);
  return {
    recorder: { backend: "parecord", source, maxDurationSeconds: integer(fallback(r.maxDurationSeconds, 300), 1, 1800, "recorder.maxDurationSeconds"),
      maxBytes: integer(fallback(r.maxBytes, 24 * 1024 * 1024), 1024, 24 * 1024 * 1024, "recorder.maxBytes"),
      stopTimeoutSeconds: integer(fallback(r.stopTimeoutSeconds, 3), 1, 15, "recorder.stopTimeoutSeconds") },
    transcription: { order, profiles, automaticFallback: boolean(fallback(t.automaticFallback, false), "transcription.automaticFallback"),
      totalTimeoutSeconds: seconds(fallback(t.totalTimeoutSeconds, 120), "transcription.totalTimeoutSeconds") },
    correction: { enabled: boolean(fallback(c.enabled, true), "correction.enabled"), order: correctionOrder, defaults: cd, modelSettings,
      context: { maxChars: integer(fallback(context.maxChars, 8000), 0, 100000, "correction.context.maxChars") },
      totalTimeoutSeconds: seconds(fallback(c.totalTimeoutSeconds, 30), "correction.totalTimeoutSeconds") },
    delivery: { dictationMarker: boolean(fallback(d.dictationMarker, false), "delivery.dictationMarker") },
    keybindings: bindings.bindings, keyErrors: bindings.errors,
  };
}
export function configSnapshot(config: Config): Config {
  function freeze(value: object): void { for (const item of Object.values(value)) if (item && typeof item === "object") freeze(item); Object.freeze(value); }
  const snapshot = structuredClone(config); freeze(snapshot); return snapshot;
}
export function transcriptionKey(profile: Profile, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (profile.auth.type === "none") return undefined;
  const key = env[profile.auth.name];
  if (!key?.trim() || /[\r\n]/u.test(key)) throw new ConfigError("Transcription credential unavailable; check the configured environment variable.");
  return key;
}

export class ConfigStore {
  readonly path: string;
  #source: string | null | undefined;
  constructor(agentDir: string) { this.path = join(agentDir, "pi-oaistt.json"); }
  async #read(): Promise<{ raw: Record<string, unknown>; bytes: string | undefined }> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new ConfigError("Configuration must be a regular file no larger than 64 KiB.");
      const bytes = await readFile(this.path, "utf8");
      let raw: unknown; try { raw = JSON.parse(bytes); } catch { throw new ConfigError("Invalid pi-oaistt.json JSON."); }
      parseConfig(raw); return { raw: raw as Record<string, unknown>, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: {}, bytes: undefined };
      if (error instanceof ConfigError) throw error;
      throw new ConfigError("Cannot read pi-oaistt.json.");
    }
  }
  async load(): Promise<Config> {
    const { raw } = await withFileMutationQueue(this.path, () => this.#read()); const config = parseConfig(raw);
    if (this.#source !== undefined) config.recorder.source = this.#source;
    return configSnapshot(config);
  }
  setSource(source: string | null): void { parseConfig({ recorder: { source } }); this.#source = source; }
  async #save(change: (raw: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    await withFileMutationQueue(this.path, async () => {
      const { raw, bytes } = await this.#read(); const next = change(raw); parseConfig(next);
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
        await writeFile(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        if ((await this.#read()).bytes !== bytes) throw new ConfigError("Configuration changed during save; retry after reviewing it.");
        await rename(temp, this.path);
      } catch (error) { if (error instanceof ConfigError) throw error; throw new ConfigError("Cannot save pi-oaistt.json."); }
      finally { await unlink(temp).catch(() => {}); }
    });
  }
  async saveSource(): Promise<void> {
    const source = this.#source;
    if (source === undefined) throw new ConfigError("No temporary source override to save.");
    await this.#save(raw => ({ ...raw, recorder: { ...object(fallback(raw.recorder, {}), "recorder"), source } }));
  }
  async saveProfile(name: string): Promise<void> {
    profileName(name);
    await this.#save(raw => {
      const config = parseConfig(raw);
      if (!config.transcription.order.includes(name)) throw new ConfigError("Unknown or inactive transcription profile.");
      const t = raw.transcription === undefined ? { order: config.transcription.order, profiles: config.transcription.profiles } : object(raw.transcription, "transcription");
      return { ...raw, transcription: { ...t, order: [name, ...config.transcription.order.filter(n => n !== name)] } };
    });
  }
}
