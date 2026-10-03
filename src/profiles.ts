/**
 * Purpose: Keep process preference separate from frozen operation routes.
 * Strategy: Fence publication against newer user intent and configuration generations.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */
import { ConfigError, configSnapshot, type Config } from "./config.ts";
export const safeLabel = (value: string): string => [...value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")].slice(0, 64).join("") || "configured candidate";
export interface SelectionToken { generation: number; intent: number; selected: string }
export class ProfileSelection {
  #config?: Config;
  #selected?: string;
  #generation = 0;
  #intent = 0;
  get selected(): string | undefined { return this.#selected; }
  get config(): Config | undefined { return this.#config; }
  /** Advance before asynchronous reload/save work can race a held success. */
  invalidate(): void { this.#generation++; this.#intent++; }
  reset(config?: Config): void { this.invalidate(); this.#config = config && configSnapshot(config); this.#selected = config?.transcription.order[0]; }
  select(name: string): number {
    if (!this.#config?.transcription.order.includes(name)) throw new ConfigError("Unknown or inactive transcription profile.");
    this.#intent++; this.#selected = name; return this.#intent;
  }
  /** Saved disk order changes future policy without undoing a newer manual choice. */
  saved(config: Config, generation: number): void {
    if (this.#generation !== generation) return;
    this.#config = configSnapshot(config); this.#generation++;
    if (!this.#selected || !config.transcription.order.includes(this.#selected)) this.#selected = config.transcription.order[0];
  }
  get generation(): number { return this.#generation; }
  snapshot(): SelectionToken {
    if (!this.#selected || !this.#config) throw new ConfigError("Transcription configuration is unavailable.");
    return { selected: this.#selected, generation: this.#generation, intent: this.#intent };
  }
  publish(token: SelectionToken, name: string): boolean {
    if (token.generation !== this.#generation || token.intent !== this.#intent || !this.#config?.transcription.order.includes(name)) return false;
    this.#selected = name; return true;
  }
  metadata(active?: string) {
    const config = this.#config;
    return { selected: this.#selected ?? null, next: this.#selected ?? null, active: active ?? null,
      default: config?.transcription.order[0] ?? null, automaticFallback: config?.transcription.automaticFallback ?? false,
      order: config?.transcription.order ?? [],
      profiles: config ? Object.entries(config.transcription.profiles).map(([name, profile]) => ({ name,
        model: safeLabel(profile.model), active: config.transcription.order.includes(name) })) : [] };
  }
}
