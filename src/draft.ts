/**
 * pi-oaistt draft delivery
 *
 * Purpose: append one owned result to the latest editor draft without submission.
 * Strategy: use a single-use invalidatable lease and synchronous read/check/write.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** One delivery lease; cancellation and append linearize synchronously. */
export class DraftLease {
  #valid = true;

  invalidate(): void {
    this.#valid = false;
  }

  get valid(): boolean {
    return this.#valid;
  }

  /** Whole semantic draft, unchanged ownership; identical output consumes no undo. */
  replace(
    ui: Pick<ExtensionUIContext, "getEditorText" | "setEditorText">,
    original: string, text: string, isCurrent: () => boolean,
  ): boolean {
    if (!text.trim() || !this.#valid || !isCurrent()) return false;
    if (ui.getEditorText() !== original) return false;
    this.#valid = false; // Our onChange must not invalidate a delivered result.
    if (text !== original) ui.setEditorText(text);
    return true;
  }

  append(
    ui: Pick<ExtensionUIContext, "getEditorText" | "setEditorText">,
    text: string,
    isCurrent: () => boolean,
    marker = false,
  ): boolean {
    const transcript = text.trim();
    if (!transcript || !this.#valid || !isCurrent()) return false;
    // No await, cursor paste, main-agent message, or starting-draft comparison.
    // Keep all existing whitespace and references. Add a space ONLY if needed.
    this.#valid = false;
    const draft = ui.getEditorText();
    const separator = draft && !/\s$/u.test(draft) ? " " : "";
    ui.setEditorText(draft + separator + (marker && draft === "" ? "this is dictated\n\n" : "") + transcript);
    return true;
  }
}
