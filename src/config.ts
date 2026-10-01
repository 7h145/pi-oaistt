import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Config {
  recorder: {
    backend: "parecord";
    source: string | null;
    maxDurationSeconds: number;
    maxBytes: number;
    stopTimeoutSeconds: number;
  };
  transcription: {
    endpoint: string;
    model: string;
    language: string | null;
    apiKeyEnv: string | null;
    timeoutSeconds: number;
  };
  correction: {
    enabled: boolean;
    models: string[];
    context: { maxChars: number };
    attemptTimeoutSeconds: number;
    totalTimeoutSeconds: number;
  };
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

function fail(field: string): never {
  // Never echo user values, JSON parser errors, filesystem paths or secrets.
  throw new ConfigError(`Invalid pi-oaistt configuration: ${field}.`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(field);
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) fail(field);
  return value;
}
function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(field);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(field);
  return value;
}
function optionalString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}
const orDefault = (value: unknown, fallback: unknown): unknown => value === undefined ? fallback : value;

/** Validate everything before any recording/request. No invalid-field fallback. */
export function parseConfig(value: unknown): Config {
  const root = object(value, "root must be an object");
  keys(root, ["recorder", "transcription", "correction"], "unknown top-level field");
  const r = object(orDefault(root.recorder, {}), "recorder");
  const t = object(orDefault(root.transcription, {}), "transcription");
  const c = object(orDefault(root.correction, {}), "correction");
  const context = object(orDefault(c.context, {}), "correction.context");
  keys(r, ["backend", "source", "maxDurationSeconds", "maxBytes", "stopTimeoutSeconds"], "recorder fields");
  keys(t, ["endpoint", "model", "language", "apiKeyEnv", "timeoutSeconds"], "transcription fields");
  keys(c, ["enabled", "models", "context", "attemptTimeoutSeconds", "totalTimeoutSeconds"], "correction fields");
  keys(context, ["maxChars"], "correction.context fields");
  const backend = orDefault(r.backend, "parecord");
  if (backend !== "parecord") fail("recorder.backend (supported: parecord)");
  const source = optionalString(orDefault(r.source, null), "recorder.source");
  if (source !== null && source.length > 512) fail("recorder.source");
  const endpoint = string(orDefault(t.endpoint, "https://api.openai.com/v1/audio/transcriptions"), "transcription.endpoint");
  try {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) fail("transcription.endpoint");
  } catch { fail("transcription.endpoint (HTTP(S) URL without credentials/query/fragment)"); }
  const apiKeyEnv = optionalString(orDefault(t.apiKeyEnv, "OPENAI_API_KEY"), "transcription.apiKeyEnv");
  if (apiKeyEnv !== null && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) fail("transcription.apiKeyEnv");
  const language = optionalString(orDefault(t.language, null), "transcription.language");
  if (language !== null && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(language)) fail("transcription.language");
  const models = orDefault(c.models, []);
  if (!Array.isArray(models) || models.length > 32) fail("correction.models");
  const candidates = models.map((model) => {
    const id = string(model, "correction.models");
    if (!/^[^/\s]+\/\S+$/u.test(id)) fail("correction.models (provider/model IDs)");
    return id;
  });
  return {
    recorder: {
      backend, source,
      maxDurationSeconds: integer(orDefault(r.maxDurationSeconds, 300), 1, 1800, "recorder.maxDurationSeconds (1–1800)"),
      maxBytes: integer(orDefault(r.maxBytes, 24 * 1024 * 1024), 1024, 24 * 1024 * 1024, "recorder.maxBytes (1024–25165824)"),
      stopTimeoutSeconds: integer(orDefault(r.stopTimeoutSeconds, 3), 1, 15, "recorder.stopTimeoutSeconds (1–15)"),
    },
    transcription: {
      endpoint,
      model: string(orDefault(t.model, "whisper-1"), "transcription.model"),
      language, apiKeyEnv,
      timeoutSeconds: integer(orDefault(t.timeoutSeconds, 60), 1, 600, "transcription.timeoutSeconds (1–600)"),
    },
    correction: {
      enabled: boolean(orDefault(c.enabled, true), "correction.enabled"),
      models: candidates,
      context: { maxChars: integer(orDefault(context.maxChars, 8000), 0, 100000, "correction.context.maxChars (0–100000 Unicode code points)") },
      attemptTimeoutSeconds: integer(orDefault(c.attemptTimeoutSeconds, 15), 1, 120, "correction.attemptTimeoutSeconds (1–120)"),
      totalTimeoutSeconds: integer(orDefault(c.totalTimeoutSeconds, 30), 1, 300, "correction.totalTimeoutSeconds (1–300)"),
    },
  };
}

export function configSnapshot(config: Config): Config {
  const snapshot = structuredClone(config);
  Object.freeze(snapshot.recorder);
  Object.freeze(snapshot.transcription);
  Object.freeze(snapshot.correction.context);
  Object.freeze(snapshot.correction.models);
  Object.freeze(snapshot.correction);
  return Object.freeze(snapshot);
}

export function transcriptionKey(config: Config, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = config.transcription.apiKeyEnv;
  if (name === null) return undefined;
  const key = env[name];
  if (!key?.trim() || /[\r\n]/u.test(key)) {
    throw new ConfigError("Transcription credential unavailable; check the configured environment variable.");
  }
  return key;
}

export class ConfigStore {
  readonly path: string;
  #source: string | null | undefined;
  constructor(agentDir: string) { this.path = join(agentDir, "pi-oaistt.json"); }

  async #read(): Promise<{ raw: Record<string, unknown>; bytes: string | undefined }> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
        throw new ConfigError("Configuration must be a regular file no larger than 64 KiB.");
      }
      const bytes = await readFile(this.path, "utf8");
      let raw: unknown;
      try { raw = JSON.parse(bytes); } catch { throw new ConfigError("Invalid pi-oaistt.json JSON."); }
      parseConfig(raw);
      return { raw: raw as Record<string, unknown>, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: {}, bytes: undefined };
      if (error instanceof ConfigError) throw error;
      throw new ConfigError("Cannot read pi-oaistt.json.");
    }
  }

  async load(): Promise<Config> {
    const { raw } = await this.#read();
    const config = parseConfig(raw);
    if (this.#source !== undefined) config.recorder.source = this.#source;
    return configSnapshot(config);
  }

  setSource(source: string | null): void {
    parseConfig({ recorder: { source } });
    this.#source = source;
  }

  /** Explicit save only; preserve other on-disk settings and detect live edits. */
  async saveSource(): Promise<void> {
    if (this.#source === undefined) throw new ConfigError("No temporary source override to save.");
    const { raw, bytes } = await this.#read();
    const recorder = object(orDefault(raw.recorder, {}), "recorder");
    const next = { ...raw, recorder: { ...recorder, source: this.#source } };
    parseConfig(next);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      // agentDir is Pi-owned; never create a project config layer.
      await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      const current = await this.#read();
      if (current.bytes !== bytes) throw new ConfigError("Configuration changed during save; retry after reviewing it.");
      await rename(temp, this.path);
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError("Cannot save pi-oaistt.json.");
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
}
