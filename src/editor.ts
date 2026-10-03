/**
 * pi-oaistt editor boundary
 *
 * Purpose: observe real prompt capture while preserving native editor semantics.
 * Strategy: use public CustomEditor callbacks and synchronously invalidate delivery.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

type CaptureKind = "submit" | "followUp";

// Pi 0.99.2 handles these before routing editor submissions to AgentSession.
// Match its exact-vs-argument behavior, not every slash-prefixed string.
// Regression tests exercise the real InteractiveMode callbacks. There is no
// public built-in-command classification API; keep this seam version-tested.
const exactCommands = new Set([
  "settings", "scoped-models", "share", "copy", "session", "changelog",
  "hotkeys", "fork", "clone", "tree", "trust", "logout", "new", "reload",
  "debug", "arminsayshi", "dementedelves", "resume", "quit",
]);
const argumentCommands = new Set([
  "model", "thinking", "export", "import", "bug", "name", "login", "compact",
]);

/** Only identify controls the native UI actually consumes, never prompt templates. */
export function isPromptCapture(
  text: string,
  kind: CaptureKind,
  extensionCommands: readonly string[],
): boolean {
  const value = text.trim();
  if (!value) return false;
  if (value.startsWith("/")) {
    const space = value.indexOf(" ");
    const name = space < 0 ? value.slice(1) : value.slice(1, space);
    if (extensionCommands.includes(name)) return false;
    if (kind === "submit" &&
        (argumentCommands.has(name) || (space < 0 && exactCommands.has(name)))) {
      return false;
    }
  }
  // Busy Alt+Enter sends even !commands as follow-up *prompt text*.
  if (kind === "submit" && value.startsWith("!")) {
    const command = value.slice(value.startsWith("!!") ? 2 : 1).trim();
    if (command) return false;
  }
  return true;
}

export interface CaptureHooks {
  /** Synchronous invalidation only. Must not await cleanup at this boundary. */
  captured(): void;
  /** Semantic content changes, synchronously, including programmatic edits/undo. */
  changed?(): void;
  extensionCommands(): readonly string[];
  /** Used only to classify native follow-up routing, NOT to gate dictation. */
  followUpUsesSubmit(): boolean;
}

/** Stock editing/shortcuts, plus observation of actual public submit callbacks. */
export class DictationEditor extends CustomEditor {
  #hooks: CaptureHooks;
  #submitWrapper?: (text: string) => void;
  #followUpWrapper?: () => void;
  #initialText: string | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    hooks: CaptureHooks,
    initialText?: string,
  ) {
    super(tui, theme, keybindings);
    this.#hooks = hooks;
    this.#initialText = initialText;
    // Public callback assignment stays intact even when Pi wires it after the
    // factory. Observe expanded semantics before forwarding the native callback.
    let previous = this.getExpandedText();
    let downstream = this.onChange;
    const changed = (text: string) => {
      const current = this.getExpandedText();
      if (current !== previous) { previous = current; this.#hooks.changed?.(); }
      downstream?.(super.getText()); // Keep native onChange display-text semantics.
    };
    Object.defineProperty(this, "onChange", {
      configurable: true,
      get: () => changed,
      set: (callback: typeof this.onChange) => { if (callback !== changed) downstream = callback; },
    });
  }

  // Pi resetExtensionUI transfers getText BEFORE session_shutdown. Returning
  // semantic text prevents reload/takeover from orphaning our private paste map.
  // Rendering still uses native lines; only transfer/getter semantics expand.
  override getText(): string { return super.getExpandedText(); }

  override setText(text: string): void {
    // Pi transfers getText(), not getExpandedText(), when installing editors.
    // Hydrate its FIRST transfer from the expanded snapshot so the new editor
    // never contains an opaque marker without its paste map (even after undo).
    const initial = this.#initialText;
    this.#initialText = undefined;
    super.setText(initial ?? text);
  }

  #capture(text: string, kind: CaptureKind): void {
    if (isPromptCapture(text, kind, this.#hooks.extensionCommands())) {
      this.#hooks.captured();
    }
  }

  override handleInput(data: string): void {
    // Pi wires these public callbacks after invoking the factory. Wrap them
    // lazily, once per assigned callback, before delegating native input.
    // Observing raw Enter would also mistake autocomplete/dialog confirmation
    // for submission. Observing the later `input` event misses compaction queues.
    if (this.onSubmit && this.onSubmit !== this.#submitWrapper) {
      const submit = this.onSubmit;
      this.#submitWrapper = (text) => {
        this.#capture(text, "submit");
        submit(text);
      };
      this.onSubmit = this.#submitWrapper;
    }
    const followUp = this.actionHandlers.get("app.message.followUp");
    if (followUp && followUp !== this.#followUpWrapper) {
      this.#followUpWrapper = () => {
        // Idle Alt+Enter invokes onSubmit in the same stack; observe it there.
        // Busy/compaction follow-up captures independently, before any await.
        if (!this.#hooks.followUpUsesSubmit()) {
          this.#capture(this.getExpandedText(), "followUp");
        }
        followUp();
      };
      this.onAction("app.message.followUp", this.#followUpWrapper);
    }
    super.handleInput(data);
  }
}

export interface EditorBoundary {
  isInstalled(): boolean;
  revision(): number;
  nativeBindings(): Record<string, string | string[] | undefined>;
  refreshNativeBindings(): void;
  dispose(): void;
}

/** Refuse to silently replace another extension's editor. */
export function installEditorBoundary(
  pi: Pick<ExtensionAPI, "getCommands">,
  ctx: Pick<ExtensionContext, "ui" | "isIdle">,
  captured: () => void,
  changed: () => void = () => {},
): EditorBoundary {
  const { ui } = ctx;
  if (ui.getEditorComponent()) {
    throw new Error("Dictation requires the stock Pi editor; another editor is installed.");
  }
  let revision = 0;
  let bindings: KeybindingsManager | undefined;
  const factory = (tui: TUI, theme: EditorTheme, kb: KeybindingsManager) =>
    (bindings = kb, new DictationEditor(tui, theme, kb, {
      captured,
      changed: () => { revision++; changed(); },
      extensionCommands: () => pi.getCommands()
        .filter((command) => command.source === "extension")
        .map((command) => command.name),
      followUpUsesSubmit: () => ctx.isIdle(),
    }, ui.getEditorText()));
  ui.setEditorComponent(factory);
  return {
    isInstalled: () => ui.getEditorComponent() === factory,
    revision: () => revision,
    nativeBindings: () => bindings?.getResolvedBindings() ?? {},
    // Full runtime setup only: Pi itself reloads this manager just AFTER
    // session_start on /reload, so refresh before our conflict snapshot too.
    refreshNativeBindings: () => bindings?.reload(),
    dispose: () => {
      if (ui.getEditorComponent() !== factory) return;
      // Restore through expanded text for the same reason as first hydration.
      ui.setEditorText(ui.getEditorText());
      ui.setEditorComponent(undefined);
    },
  };
}

export { DraftLease } from "./draft.ts";
