/**
 * pi-oaistt native Pi UI fixture
 *
 * Purpose: exercise native editor/input wiring without a live agent or terminal.
 * Strategy: isolate test-only InteractiveMode wiring and use Pi's own TUI registry.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.1.0
 * Date: 2026-10-01
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CustomEditor, InteractiveMode, initTheme, createSyntheticSourceInfo,
  type ExtensionUIContext, type KeybindingsManager as PiKeybindings } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, Terminal, TUI, KeybindingsConfig } from "@earendil-works/pi-tui";

// Pi's shrinkwrapped npm dependency tree can contain two physical TUI copies.
// Mimic the host's extension mapping: use the TUI resolved from Pi itself.
const hostRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { Container, Input, TuiAltScreen, TuiMainScreen, setKeybindings } =
  await import(pathToFileURL(hostRequire.resolve("@earendil-works/pi-tui")).href) as typeof import("@earendil-works/pi-tui");
// Test-only access to native host keybindings (not value-exported by Pi).
const { KeybindingsManager } = await import(pathToFileURL(join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/keybindings.js",
)).href) as { KeybindingsManager: new (config?: KeybindingsConfig) => PiKeybindings };

export class SyntheticTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  input?: (data: string) => void;
  output: string[] = [];
  start(input: (data: string) => void): void { this.input = input; }
  stop(): void { this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void {
    if (!this.input) throw new Error("Synthetic terminal not started");
    this.input(data);
  }
}

const plain = (s: string) => s;
export const editorTheme: EditorTheme = {
  borderColor: plain,
  selectList: {
    selectedPrefix: plain, selectedText: plain, description: plain,
    scrollInfo: plain, noMatch: plain,
  },
};

interface NativeSession {
  isStreaming: boolean;
  isCompacting: boolean;
  isBashRunning: boolean;
  extensionRunner: { getCommand(name: string): object | undefined };
  prompt(text: string, options?: { streamingBehavior?: string }): Promise<void>;
}

/** Test-only access to Pi's PRIVATE host wiring; production uses public APIs.
 * Native methods run unchanged. Network/agent/auth and unrelated UI panels are
 * replaced by deterministic fixtures, NOT the submit or compaction queue code.
 * No user configuration, credential, transcript, or microphone is read.
 */
interface NativeModeFixture {
  runtimeHost: { session: NativeSession };
  ui: TUI;
  editor: CustomEditor;
  defaultEditor: CustomEditor;
  keybindings: PiKeybindings;
  editorContainer: InstanceType<typeof Container>;
  statusContainer: InstanceType<typeof Container>;
  editorComponentFactory?: unknown;
  pendingUserInputs: string[];
  compactionQueuedMessages: { text: string; mode: string }[];
  onInputCallback?: (text: string) => void;
  setupEditorSubmitHandler(): void;
  setupExtensionShortcuts(runner: { getModelRegistry(): unknown; getShortcuts(config: KeybindingsConfig): Map<string, { handler(ctx: unknown): unknown }> }): void;
  createExtensionUIContext(): ExtensionUIContext;
  handleFollowUp(): Promise<void>;
  flushPendingBashComponents(): void;
  updatePendingMessagesDisplay(): void;
  showStatus(text: string): void;
  [name: string]: unknown;
}

export function createPiUI(options: {
  mode?: "regular" | "fullscreen";
  streaming?: boolean;
  compacting?: boolean;
  bindings?: KeybindingsConfig;
  prompt?: NativeSession["prompt"];
} = {}) {
  initTheme("dark", false);
  const terminal = new SyntheticTerminal();
  const tui = options.mode === "fullscreen"
    ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const keybindings = new KeybindingsManager(options.bindings);
  setKeybindings(keybindings);
  const mode = Object.create(InteractiveMode.prototype) as NativeModeFixture;
  const commands = new Set(["oaistt", "other-extension"]);
  const promptCalls: { text: string; behavior?: string }[] = [];
  const session: NativeSession = {
    isStreaming: options.streaming ?? false,
    isCompacting: options.compacting ?? false,
    isBashRunning: false,
    extensionRunner: { getCommand: (name) => commands.has(name) ? {} : undefined },
    prompt: options.prompt ?? (async (text, opts) => {
      promptCalls.push({ text, behavior: opts?.streamingBehavior });
    }),
  };
  mode.runtimeHost = { session };
  mode.ui = tui;
  mode.keybindings = keybindings;
  mode.editorContainer = new Container();
  mode.statusContainer = new Container();
  mode.defaultEditor = new CustomEditor(tui, editorTheme, keybindings);
  mode.editor = mode.defaultEditor;
  mode.pendingUserInputs = [];
  mode.compactionQueuedMessages = [];
  mode.flushPendingBashComponents = () => {};
  mode.updatePendingMessagesDisplay = () => {};
  mode.showStatus = () => {};
  mode.setupEditorSubmitHandler();
  const followUps: Promise<void>[] = [];
  mode.defaultEditor.onAction("app.message.followUp", () => {
    followUps.push(mode.handleFollowUp());
  });
  mode.editorContainer.addChild(mode.editor);
  tui.addChild(mode.editorContainer);
  tui.setFocus(mode.editor);
  tui.start();
  const ui = mode.createExtensionUIContext();
  return {
    terminal, tui, mode, ui, session, promptCalls, commands, followUps,
    isIdle: () => !session.isStreaming && !session.isCompacting,
    pi: {
      getCommands: () => [...commands].map((name) => ({
        name, source: "extension" as const,
        sourceInfo: createSyntheticSourceInfo("<test:command>", { source: "test" }),
      })),
    },
    showDialog: () => {
      const dialog = new Input();
      tui.addChild(dialog);
      tui.setFocus(dialog);
      return dialog;
    },
    stop: () => {
      mode.editor.setText(""); // cancels any native autocomplete timers
      tui.stop();
    },
  };
}
