# Engineering evidence

## Baseline and development setup

Primary implementation/test baseline: Pi 0.99.2. Tests run on Node 26.10.0;
Node 22.19+ is the declared baseline (its TypeScript stripping runs `.ts` tests).
Use `npm ci --ignore-scripts`, `npm run check`, and `npm test`. Dependency scripts
are not needed for this synthetic gate. No microphone or provider is contacted.
The lockfile pins development dependencies; production imports use Pi's public
root exports. Pi supplies peer modules to loaded extensions.

The approved implementation handoff supplied by the owner remains the product
contract. The v1 target is not a claim of completed functionality or release
readiness. No external reference implementation has been copied into this code.

## First feasibility gate: editor capture and delivery

Source inspected: Pi 0.99.2 public declarations/examples and installed
`InteractiveMode`, `CustomEditor`, and TUI `Editor` implementations. Product code
only uses public APIs. No footer replacement, terminal-wide Enter interception,
private UI monkey patch or main-agent prompt API is used.

### Mechanism

- Install a small `CustomEditor` subclass through `setEditorComponent`. Preserve
  native editing, app handlers, extension shortcuts and main-agent Escape.
- Wrap public `onSubmit` and `app.message.followUp` callbacks after Pi wires them,
  before delegating editor input. Observe actual capture, not every Enter key.
- Native idle follow-up calls `onSubmit` synchronously; busy/compaction follow-up
  has its own capture path. `ctx.isIdle()` only classifies that native path; it
  never restricts dictation start/stop or delivery.
- Invalidate a delivery lease synchronously before native submit work can await
  authentication, provider calls or processing. Native Enter clears/captures the
  editor just before `onSubmit`, in the same synchronous stack; there is no event
  loop yield in between. A later `input` event alone would miss UI compaction
  queues and is not the primary guard.
- Exclude actual extension controls, exact built-in UI controls and nonempty bash
  commands from ordinary submission classification. Prompt templates, skills,
  unknown slash text, malformed controls and busy follow-up prompt text remain
  submissions. The built-in-control classification is a small version-tested
  table because Pi does not export a public classification API.
- Append synchronously using `getEditorText()`/`setEditorText()` with a final
  ownership check. Preserve all existing draft text/whitespace. Add one space
  only if the nonempty draft does not end in whitespace; trim only the incoming
  transcript's outer whitespace. Do not insert at the cursor or submit.

### Paste, attachment and undo evidence

Pi's getter expands collapsed paste markers, and its setter snapshots the paste
map for undo before clearing display state. Append expands visual paste collapsing
but preserves semantic content; one native undo restores the pre-append draft,
including its paste map. Native clipboard images are inserted by Pi as temporary
file paths, not a separate editor attachment object (`handleClipboardPaste`).
Tests preserve these paths and `@` references verbatim along with multiline paste
content; live clipboard/image-provider behavior is not yet validated.

Pi's editor-factory installation copies **unexpanded** `getText()`. The subclass
hydrates that first transfer from the expanded public getter, otherwise it would
inherit opaque markers with no paste map. Restoration similarly expands text
before reverting to stock. Installation changes editor instance/history; append
itself is undoable. The adapter refuses to replace an already-installed custom
editor, and refuses delivery if another extension takes over afterward. Arbitrary
custom-editor composition is not claimed.

### Automated results

`npm run check` and **36 tests** pass. Tests use real Pi 0.99.2 editor/UI callback
implementations and real regular/fullscreen TUI focus/input routing on a synthetic
terminal. The test-only host fixture accesses private InteractiveMode wiring to
isolate native callbacks; it fakes the agent/network/auth and unrelated UI panels,
not submit, follow-up, compaction queuing or editor APIs. It does not start a full
Pi agent session. Production code has no private imports/access.

Covered: idle/busy/compaction Enter and Alt+Enter; invalidation before native
routing and delayed completions; delivery-before-submit; one append per lease;
control commands; typing; F8 forwarding; main-agent Escape forwarding;
dialog/autocomplete focus; reconfigured keys; multiline large pastes, whitespace,
file/image path references and undo; install/restore; lost-editor ownership;
invalid/stale/empty deliveries.

Test-harness pitfall found and resolved: Pi's npm shrinkwrap can install a nested
TUI copy even when the product has a same-version TUI development peer. Importing
that other copy made native Editor use different global keybindings. The fixture
resolves the TUI **from Pi's own module root**, as Pi maps extension imports. The
fixture also uses native host keybindings. Never interpret a split-registry test
as proof of actual Pi behavior.

## Configuration and owned-operation controller

The tested schema/defaults/credential references and source-save behavior are in
[configuration.md](docs/configuration.md). Missing correction candidates remain
an empty list; invalid settings never silently reroute. Temporary source overrides
stay in memory; explicit source saves preserve other live config fields and use
private atomic writes. No config is created merely by loading defaults.

The controller allocates one operation synchronously and starts lifetime work in
a separate task. It owns an abort controller and delivery lease, freezes settings,
and retains recorder ownership until disposal succeeds. `starting` is a separate
phase before recorder readiness, so later adapters need not falsely show REC while
probing/connecting. A toggle in starting/recording requests stop; during processing
it reports phase without starting another operation. Cancellation invalidates
immediately, emits one fixed notice, and never waits for/aborts the main agent.

Bounded stages settle even when a provider ignores abort. Correction error/empty
result/total timeout yields raw text plus one notice; user cancellation yields no
raw or corrected text. Disabled correction makes no correction request. Stale
callbacks cannot affect a later operation. Phase status is cleared before teardown;
failed disposal retains ownership and blocks another recorder rather than hiding
an orphan. Adapter disposal itself must be idempotent and bounded.

Total suite: **102 passing tests** plus typecheck. Controller tests use deterministic
recorder/provider fakes, held cleanup and mock deadlines; they exercise cancellation,
submission and session-discard reasons in starting, recording, stopping,
transcribing and correcting. Production Pi lifecycle wiring and presentation are
still pending; fake pipeline success is not a live microphone/provider claim.

## Next implementation work / unvalidated acceptance

- Recorder/provider and Pi command/lifecycle adapters, including pre-start auth
  validation and real status/notices/timer cleanup.
- Private recorder, graceful stop/escalation/reaping, WAV validation and capture
  completeness. Historical 7-second/6-second pathfinder observation is unresolved.
- Compatible bounded multipart transcription with redacted failures.
- Compaction-aware text/summaries context; isolated correction; explicit ordered
  candidates, owned cancellation and candidate/total deadlines.
- F8/commands, source adjustment, explicit persistence, install/config/privacy
  docs and package manifest. No dictation extension is exposed yet.
- Full interactive session lifecycle/auth/provider tests, live busy-agent behavior,
  actual terminal/tmux F8, normal/boxed audio and local/remote STT matrix, correction
  quality and footer visibility. Synthetic gate results do not establish these.

No real audio, transcript, credentials or user configuration are test fixtures.
