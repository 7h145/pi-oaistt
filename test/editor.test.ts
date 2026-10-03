/**
 * pi-oaistt editor tests
 *
 * Purpose: verify editor behavior without real audio, credentials or provider calls.
 * Strategy: combine synthetic inputs and controlled failures with relevant real APIs.
 *
 * Author: thias <github.attic@typedef.net>, OpenAI Codex (gpt-6.1-sol)
 * License: MIT
 * Version: 0.2.0
 * Date: 2026-10-03
 * Last verified with Pi: 0.99.2 (synthetic APIs)
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setImmediate as nextTask } from "node:timers/promises";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider } from "@earendil-works/pi-tui";
import { DictationEditor, DraftLease, installEditorBoundary, isPromptCapture } from "../src/editor.ts";
import { createPiUI } from "./pi-ui-fixture.ts";

const open: ReturnType<typeof createPiUI>[] = [];
afterEach(() => { for (const h of open.splice(0)) h.stop(); });
function fixture(options: Parameters<typeof createPiUI>[0] = {}) {
  const h = createPiUI(options);
  open.push(h);
  let lease = new DraftLease();
  let captures = 0;
  const boundary = installEditorBoundary(h.pi as Pick<ExtensionAPI, "getCommands">,
    { ui: h.ui, isIdle: h.isIdle }, () => { captures++; lease.invalidate(); });
  return {
    ...h,
    boundary,
    get lease() { return lease; },
    count: () => captures,
    renew: () => { lease = new DraftLease(); return lease; },
    append: (text = "synthetic dictation") => lease.append(h.ui, text, boundary.isInstalled),
  };
}

for (const mode of ["regular", "fullscreen"] as const) {
  for (const state of ["idle", "streaming", "compacting"] as const) {
    for (const [key, behavior] of [["\r", "steer"], ["\x1b\r", "followUp"]] as const) {
      test(`${mode} ${state}: native ${behavior} capture invalidates before routing`, async () => {
        const h = fixture({ mode, streaming: state === "streaming", compacting: state === "compacting" });
        h.ui.setEditorText("synthetic prompt");
        let validWhenRouted: boolean | undefined;
        h.session.prompt = async (text) => {
          validWhenRouted = h.lease.valid;
          assert.equal(text, "synthetic prompt");
          // Simulate delayed auth/provider success; it must not permit delivery.
          await nextTask();
          assert.equal(h.append(), false);
        };
        h.mode.onInputCallback = (text) => {
          validWhenRouted = h.lease.valid;
          assert.equal(text, "synthetic prompt");
        };
        h.terminal.send(key);
        assert.equal(h.lease.valid, false);
        assert.equal(h.count(), 1);
        assert.equal(h.ui.getEditorText(), "");
        assert.equal(h.append(), false);
        if (state === "compacting") {
          assert.deepEqual(h.mode.compactionQueuedMessages,
            [{ text: "synthetic prompt", mode: behavior }]);
          // No later `input` event needed: the UI already owns the queued text.
          assert.equal(validWhenRouted, undefined);
        } else {
          assert.equal(validWhenRouted, false);
        }
        await Promise.all(h.followUps);
        await nextTask();
      });
    }
  }

  test(`${mode}: delivery first is included in the captured prompt`, async () => {
    const h = fixture({ mode, streaming: true });
    h.ui.setEditorText("typed first");
    assert.equal(h.append("spoken second"), true);
    assert.equal(h.append("duplicate"), false);
    h.terminal.send("\x1b\r");
    await Promise.all(h.followUps);
    assert.deepEqual(h.promptCalls, [{ text: "typed first spoken second", behavior: "followUp" }]);
  });

  test(`${mode}: dialog focus, Enter and Alt+Enter do not capture editor draft`, () => {
    const h = fixture({ mode, streaming: true });
    h.ui.setEditorText("kept draft");
    const dialog = h.showDialog();
    let dialogSubmitted = false;
    dialog.onSubmit = () => { dialogSubmitted = true; };
    h.terminal.send("\r");
    h.terminal.send("\x1b\r");
    assert.equal(dialogSubmitted, true);
    assert.equal(h.count(), 0);
    assert.equal(h.ui.getEditorText(), "kept draft");
    assert.equal(h.append(), true);
  });
}

test("intervening typing, F8 and main-agent Escape preserve lease and controls", () => {
  const h = fixture({ streaming: true });
  let toggled = 0;
  let mainAbort = 0;
  h.mode.defaultEditor.onExtensionShortcut = (data) => {
    if (data !== "\x1b[19~") return false;
    toggled++;
    return true;
  };
  h.mode.defaultEditor.onEscape = () => { mainAbort++; };
  h.terminal.send("typed");
  h.terminal.send("\x1b[19~");
  h.terminal.send("\x1b");
  assert.equal(toggled, 1);
  assert.equal(mainAbort, 1);
  assert.equal(h.count(), 0);
  assert.equal(h.append(), true);
  assert.equal(h.ui.getEditorText(), "typed synthetic dictation");
});

for (const state of ["idle", "streaming", "compacting"] as const) {
  for (const key of ["\r", "\x1b\r"]) {
    test(`${state} control command ${JSON.stringify(key)} is not a prompt`, async () => {
      const h = fixture({ streaming: state === "streaming", compacting: state === "compacting" });
      h.ui.setEditorText("/oaistt cancel");
      h.terminal.send(key);
      assert.equal(h.count(), 0);
      assert.equal(h.lease.valid, true);
      assert.deepEqual(h.mode.compactionQueuedMessages, []);
      await Promise.all(h.followUps);
    });
  }
}

test("stock file autocomplete Enter is not submission", async () => {
  const h = fixture();
  const provider: AutocompleteProvider = {
    getSuggestions: async () => ({ prefix: "@f", items: [
      { value: "@fixture.ts", label: "fixture.ts" },
      { value: "@fixture2.ts", label: "fixture2.ts" },
    ] }),
    applyCompletion: () => ({ lines: ["@fixture.ts "], cursorLine: 0, cursorCol: 12 }),
  };
  h.mode.editor.setAutocompleteProvider(provider);
  h.ui.setEditorText("@f");
  h.terminal.send("\t");
  await nextTask();
  assert.equal(h.mode.editor.isShowingAutocomplete(), true);
  h.terminal.send("\r");
  assert.equal(h.count(), 0);
  assert.equal(h.lease.valid, true);
  assert.equal(h.ui.getEditorText(), "@fixture.ts ");
});

test("slash autocomplete is classified after completion, not as an Enter key", async () => {
  const h = fixture();
  h.mode.editor.setAutocompleteProvider({
    getSuggestions: async () => ({ prefix: "/o", items: [{ value: "/oaistt", label: "oaistt" }] }),
    applyCompletion: () => ({ lines: ["/oaistt"], cursorLine: 0, cursorCol: 7 }),
  });
  h.ui.setEditorText("/o");
  h.terminal.send("\t");
  await nextTask();
  assert.equal(h.mode.editor.isShowingAutocomplete(), true);
  h.terminal.send("\r");
  assert.equal(h.count(), 0);
});

test("native configurable submit/follow-up bindings, not hard-coded Enter", async () => {
  const h = fixture({ streaming: true,
    bindings: { "tui.input.submit": "ctrl+s", "app.message.followUp": "ctrl+q" } });
  h.ui.setEditorText("prompt");
  h.terminal.send("\x11");
  assert.equal(h.count(), 1);
  await Promise.all(h.followUps);
  h.renew();
  h.ui.setEditorText("second");
  h.terminal.send("\x13");
  assert.equal(h.count(), 2);
});

for (const trailing of ["", " ", "\n", "\n\n"]) {
  test(`append preserves expanded paste, paths, image references and whitespace ${JSON.stringify(trailing)}`, () => {
    const h = fixture();
    const longText = Array.from({ length: 12 }, (_, n) => `synthetic pasted line ${n}`).join("\n");
    h.ui.setEditorText("  @src/example.ts\n/tmp/synthetic-image.png\n");
    h.ui.pasteToEditor(longText);
    h.terminal.send(trailing);
    const visibleBefore = h.mode.editor.getLines().join("\n");
    const semanticBefore = h.ui.getEditorText();
    assert.match(visibleBefore, /\[paste #/);
    assert.match(semanticBefore, /synthetic pasted line 11/);
    assert.equal(h.append("spoken"), true);
    const expected = semanticBefore + (/\s$/u.test(semanticBefore) ? "" : " ") + "spoken";
    assert.equal(h.ui.getEditorText(), expected);
    assert.doesNotMatch(h.mode.editor.getLines().join("\n"), /\[paste #/);
    h.terminal.send("\x1f"); // native ctrl+- undo
    assert.equal(h.ui.getEditorText(), semanticBefore);
    assert.equal(h.mode.editor.getLines().join("\n"), visibleBefore);
  });
}

test("install and restore never orphan an existing collapsed paste", () => {
  const h = createPiUI();
  open.push(h);
  const text = "synthetic\n".repeat(15);
  h.ui.pasteToEditor(text);
  const before = h.ui.getEditorText();
  assert.match(h.mode.editor.getLines().join("\n"), /\[paste #/);
  const boundary = installEditorBoundary(h.pi as Pick<ExtensionAPI, "getCommands">,
    { ui: h.ui, isIdle: h.isIdle }, () => {});
  assert.equal(h.ui.getEditorText(), before);
  assert.doesNotMatch(h.mode.editor.getLines().join("\n"), /\[paste #/);
  h.terminal.send("\x1f");
  assert.doesNotMatch(h.mode.editor.getLines().join("\n"), /\[paste #/);
  h.ui.pasteToEditor(text);
  const beforeRestore = h.ui.getEditorText();
  boundary.dispose();
  boundary.dispose();
  assert.equal(h.ui.getEditorText(), beforeRestore);
  assert.equal(h.ui.getEditorComponent(), undefined);
  assert.doesNotMatch(h.mode.editor.getLines().join("\n"), /\[paste #/);
});

test("ownership invalidation/session replacement and new lease ignore late results", () => {
  const h = fixture();
  const old = h.lease;
  old.invalidate();
  const current = h.renew();
  assert.equal(old.append(h.ui, "late old result", () => true), false);
  assert.equal(current.append(h.ui, "current result", () => true), true);
  assert.equal(h.ui.getEditorText(), "current result");
});

test("editor factory replacement refuses late append and does not undo new owner", () => {
  const h = fixture();
  const other = (tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1], kb: ConstructorParameters<typeof CustomEditor>[2]) =>
    new CustomEditor(tui, theme, kb);
  h.ui.setEditorComponent(other);
  assert.equal(h.append(), false);
  h.boundary.dispose();
  assert.equal(h.ui.getEditorComponent(), other);
  assert.throws(() => installEditorBoundary(h.pi as Pick<ExtensionAPI, "getCommands">,
    { ui: h.ui, isIdle: h.isIdle }, () => {}), /another editor/);
});

test("empty transcription or invalid ownership does not read/write editor", () => {
  const ui = { getEditorText: () => { throw new Error("read"); }, setEditorText: () => { throw new Error("write"); } };
  assert.equal(new DraftLease().append(ui, "\n ", () => true), false);
  assert.equal(new DraftLease().append(ui, "valid", () => false), false);
});

test("classification handles exact controls, arguments, templates and malformed commands", () => {
  for (const text of ["", "  ", "/oaistt", "/oaistt cancel", "/other-extension args"]) {
    assert.equal(isPromptCapture(text, "submit", ["oaistt", "other-extension"]), false);
  }
  for (const text of ["/settings", "/model provider/model", "/compact preserve names", "!echo fixture", "!!echo fixture"]) {
    assert.equal(isPromptCapture(text, "submit", []), false);
    assert.equal(isPromptCapture(text, "followUp", []), true);
  }
  for (const text of ["/settings extra", "/unknown", "/template", "/skill:example", "!", "!!", "/oaistt\targ", "normal"]) {
    assert.equal(isPromptCapture(text, "submit", ["oaistt"]), true);
  }
});

// Smoke-check that the fixture actually installed the product public subclass.
test("installed editor is DictationEditor", () => {
  assert.equal(fixture().mode.editor instanceof DictationEditor, true);
});

for (const mode of ["regular", "fullscreen"] as const) {
  test(`${mode}: semantic revisions are eager across typing/paste/set/undo and edit-revert`, () => {
    const h = createPiUI({ mode, streaming: true }); open.push(h);
    let pending = false, cancellations = 0, callbacks = 0;
    const boundary = installEditorBoundary(h.pi as Pick<ExtensionAPI, "getCommands">,
      { ui: h.ui, isIdle: h.isIdle }, () => {}, () => { if (pending) { pending = false; cancellations++; } });
    h.mode.editor.onChange = () => { callbacks++; };
    h.ui.setEditorText("  @src/synthetic.ts\n/tmp/synthetic.png\n");
    h.ui.pasteToEditor("synthetic pasted line\n".repeat(15));
    const before = h.ui.getEditorText(), visible = h.mode.editor.getLines().join("\n");
    const revision = boundary.revision();
    pending = true; h.terminal.send("x");
    assert.equal(pending, false); assert.equal(cancellations, 1);
    h.terminal.send("\x1f"); assert.equal(h.ui.getEditorText(), before);
    assert.ok(boundary.revision() > revision);
    const lease = new DraftLease();
    assert.equal(lease.replace(h.ui, before, before.replace("@src/", "@lib/"), boundary.isInstalled), true);
    h.terminal.send("\x1f");
    assert.equal(h.ui.getEditorText(), before); assert.equal(h.mode.editor.getLines().join("\n"), visible);
    const same = boundary.revision(); h.terminal.send("\x1b[D"); h.showDialog();
    assert.equal(boundary.revision(), same); // Cursor/focus do not change ownership.
    h.ui.setEditorText(before); assert.equal(boundary.revision(), same);
    pending = true; h.ui.pasteToEditor("/tmp/another-synthetic.png");
    assert.equal(pending, false); assert.equal(cancellations, 2);
    pending = true; h.ui.setEditorText("programmatic"); h.ui.setEditorText(before);
    assert.equal(pending, false); assert.equal(cancellations, 3); assert.ok(callbacks > 3);
    const writes: string[] = [];
    assert.equal(new DraftLease().replace({ getEditorText: () => before, setEditorText: t => writes.push(t) },
      before, before, () => true), true); assert.deepEqual(writes, []);
  });
}

test("marker is strict-empty, same undo transaction, never whitespace or reference emptiness", () => {
  for (const draft of ["", " ", "\n", "/tmp/synthetic.png", "@src/synthetic.ts"]) {
    const h = fixture(); h.ui.setEditorText(draft);
    assert.equal(h.lease.append(h.ui, "spoken", h.boundary.isInstalled, true), true);
    assert.equal(h.ui.getEditorText().startsWith("this is dictated\n\n"), draft === "");
    h.terminal.send("\x1f"); assert.equal(h.ui.getEditorText(), draft);
  }
});
