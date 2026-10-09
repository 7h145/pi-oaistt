/**
 * Purpose: Remember the correction choice without changing saved configuration.
 * Strategy: Ignore old successes after a newer selection or settings change.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.2
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */
import { ConfigError, type Config } from "./config.ts";

export interface CorrectionSelectionToken {
  generation: number;
  intent: number;
  selected?: string;
}

/** The selected entry and following entries only; never wrap to earlier models. */
export function correctionCandidates(config: Config, selected = config.correction.order[0]): string[] {
  if (selected === undefined) return [];
  const index = config.correction.order.indexOf(selected);
  return index < 0 ? [] : config.correction.order.slice(index);
}

export class CorrectionSelection {
  #order: string[] = [];
  #selected?: string;
  #generation = 0;
  #intent = 0;
  get selected(): string | undefined { return this.#selected; }
  get generation(): number { return this.#generation; }
  invalidate(): void { this.#generation++; this.#intent++; }
  reset(config?: Config): void {
    this.invalidate();
    this.#order = config ? [...config.correction.order] : [];
    this.#selected = this.#order[0];
  }
  select(selector: string): void {
    if (!this.#order.includes(selector)) throw new ConfigError("Unknown or inactive correction model selector.");
    this.#intent++;
    this.#selected = selector;
  }
  /** Keep a newer temporary choice when an earlier save finishes. */
  saved(config: Config, generation: number): void {
    if (generation !== this.#generation) return;
    this.#order = [...config.correction.order];
    this.#generation++;
    if (!this.#selected || !this.#order.includes(this.#selected)) this.#selected = this.#order[0];
  }
  snapshot(): CorrectionSelectionToken {
    return { selected: this.#selected, generation: this.#generation, intent: this.#intent };
  }
  publish(token: CorrectionSelectionToken, selector: string): boolean {
    if (token.generation !== this.#generation || token.intent !== this.#intent || !this.#order.includes(selector)) return false;
    this.#selected = selector;
    return true;
  }
  metadata(config?: Config) {
    return {
      selected: this.#selected ?? null, next: this.#selected ?? null,
      default: this.#order[0] ?? null, automatic: config?.correction.automatic ?? null,
      order: [...this.#order], candidates: config ? correctionCandidates(config, this.#selected) : [],
    };
  }
}
