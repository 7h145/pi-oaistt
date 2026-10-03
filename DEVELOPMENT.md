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

## v0.2.0 work in progress

Owner authorized implementation after the umbrella plan readback. Local annotated
`v0.1.0` points to `8ddb5a9`; no push/release. Target contract is Pathfinder
`59c3521`. Private v0.1 settings are deliberately not migrated automatically.

Step 1 (synthetic native API gate): typecheck and **202/202** tests pass.
New public `onChange` observation proves synchronous semantic revisions through
programmatic setters, typing, paste and undo/edit-and-revert while preserving Pi's
assigned downstream callback. Cursor/focus and identical semantic setters do not
advance revisions. Whole-draft replacement and marker use the same public setter's
undo transaction; expanded paste maps and synthetic path/image references survive
undo in regular/fullscreen busy fixtures. Identical replacement does not write.

Public Pi AI supported-level helpers distinguish nonreasoning/off, standard
reasoning, unsupported null entries and opt-in max. Registry/faux requests and a
network-disabled native compatible-adapter payload fixture prove omitted reasoning
and mapped low. Explicit off is represented by omitted `reasoning`, after validating
support, **not** an invalid off cast. Native shortcut setup captures its map; source
inspection confirms full reload resets the old callback before new setup. Tests
isolate that reset (not a complete InteractiveMode reload integration).

Not yet proved: actual F7/controller integration, all thinking payload variants,
complete reload/conflict lifecycle and live clipboard/hardware/provider acceptance.
The new replacement/marker primitives are not yet wired to user controls.

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

At this milestone, `npm run check` and **36 tests** passed. Tests use real Pi 0.99.2 editor/UI callback
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
transcribing and correcting. At this milestone, production Pi lifecycle wiring and presentation were
still pending; fake pipeline success is not a live microphone/provider claim.

## Recorder and compatible transcription adapter

Implemented one deliberate Linux backend: parecord/Pulse (including PipeWire-Pulse).
Resolve the default source per capture, or apply only the explicit config/env source
as an argv option; preflight missing/muted/monitor sources without changing host
routing. Own the startup handle before readiness, require first private-file audio
bytes before REC, and use private mode-0700/0600 storage. Cap recording duration/size;
SIGINT finalization must exit and validate before upload. Graceful-stop timeout
escalates TERM/KILL, reaps only the owned detached group and refuses upload even if
the forced-stop artifact parses. Disposal is idempotent and includes unfinished
startup. Exact digital silence fails separately from structural WAV validity;
quiet nonzero PCM is accepted. Final PCM duration is checked against the capture
plus graceful-stop budget, including a second check before upload.

Transcription uses bounded multipart WAV/model/language/JSON requests, explicit
optional bearer auth, no automatic redirects, a constant upload filename and bounded
UTF-8 JSON response decoding. Errors never echo provider bodies. Both operation and
HTTP layers enforce owned cancellation/deadlines, even with uncooperative fetch.

Total suite: **131 passing tests** plus typecheck. Added real detached Node child
fixtures emitting ONLY synthetic PCM to test graceful finalization, invalid/silent
WAV, oversized files, spawn/stop failure, kill/reap, routing and cancellation. A
real loopback HTTP server verifies multipart fields/auth/PCM and nonempty JSON;
negative response/cancellation tests are synthetic. No hardware/provider tests run
as part of the automated suite.

### Owner-authorized live playback-monitor experiment

The owner offered running playback as a simulated microphone and a loopback Whisper
server. Consumed the existing host-provided Pulse route and installed container-only
`pulseaudio-utils`; no host defaults, mute, volume or exposure were changed. Manual
capture targeted the default **sink's playback monitor**, NOT a microphone. Private
audio was removed after each request; no transcript/audio/provider body was logged
or added to fixtures/commits. Only timing/format/nonempty-response metadata remains.

- Default parecord buffering: 6.006 s wall capture, first file audio at 2072 ms,
  3 ms finalization, PCM16 mono 16 kHz WAV 4.000 s / 64000 frames. Compatible local
  JSON `text` returned in 291 ms.
- Per-stream `--latency-msec=100 --process-time-msec=20`: 6.024 s wall capture,
  first file audio at 153 ms, 3 ms finalization, WAV 5.900 s / 94400 frames. Compatible
  nonempty local JSON `text` returned in 319 ms. These flags now ship in the adapter.

This exposes and substantially reduces a real trailing-buffer discrepancy; it does
NOT establish microphone correctness, intelligibility, no clipped last phoneme,
Bluetooth latency, exact wall/PCM equality or complete extension UX. Production
still refuses playback monitors as mic sources. Actual microphone/terminal/provider
matrix and speech-tail review remain release checks.

## Isolated correction and public Pi integration

Implemented `src/correction.ts`: consume `buildSessionProjection()` rather than
raw history or a flattened prompt. Preserve eligible committed active-branch text
and projected compaction/branch summaries, respecting context-edit omissions.
Exclude by source-entry provenance as well as projected role: custom messages and
metadata can otherwise look like user messages. Zero context budget never reads
history. Newest eligible text is budgeted in Unicode code points, including labels;
all candidates receive the same initial context/transcript snapshot.

Correction streams through the public Pi model registry with explicit ordered
models, no tools and an isolated system prompt/JSON data message. Fresh request
objects prevent a provider mutating a later attempt. Candidate errors/missing
auth/empty or invalid output/attempt timeout advance; exhaustion/total timeout uses
raw text. Cancellation delivers neither. No selected model, main signal, main
prompt, agent turn, prompt queue or result persistence is used.

`index.ts` and `pi.extensions` expose the extension directory. The factory has no
config I/O, timers, processes or provider requests. TUI session start installs the
editor boundary and loads settings; RPC/print/JSON never record or read config.
F8/`/oaistt`, cancel/help/status/settings reload, temporary source input and explicit
save are wired. Credentials validate before capture. One operation captures its
pipeline/session/registry references; later setting changes cannot reroute it.
Pre-navigation events synchronously cancel even if navigation is later vetoed.
Shutdown/reload cancels owned work, clears feedback and restores the stock editor.
An editor takeover is never overwritten or allowed to receive an obsolete result.

Feedback uses only public `setStatus`/`setWidget`: stable status key
`footer-compositor:right:80:pi-oaistt` (optional pi-assorted compositor convention),
red `● REC mm:ss`, muted phases, one above-editor widget and a cleared owned timer.
No footer takeover or private presentation patch. Muted notices report fixed
categories/coarse policy, never source/endpoint/credential/transcript values.
Actual footer/compositor rendering remains unvalidated.

After a clean `npm ci --ignore-scripts`, **175 tests and typecheck pass** on Node
26.10.0/Pi 0.99.2. New evidence includes:

- Real public discovery/jiti/ExtensionRunner of a synthetic project's symlinked
  package directory; command/shortcut registration, ready/help/status, TUI startup
  and shutdown/restoration. Config/auth are temporary/synthetic; no provider/audio
  request occurs. This is loader evidence, not a full live user session.
- Real native F8 dispatcher and regular/fullscreen TUI input through the adapter,
  idle/streaming/compaction; stop/latest-draft delivery without a main-agent action.
- Integrated submit/follow-up synchronous cancellation; Escape forwarding vs
  dedicated cancel; navigation/reload/late correction; retained cleanup ownership;
  timer/widget clearing and editor takeover. Backend work is synthetic here.
- Real SessionManager projection with summaries/context edits/branch selection;
  source exclusions and Unicode budgets; malicious data isolation and fresh-request
  failover; abort/attempt/total budgets; native public ModelRuntime/provider-registry
  streaming with faux auth, including missing-auth skip. No external LLM is called.
- Regression: a prompt submitted after successful delivery while cleanup remains
  held does not emit a false unfinished-result-discard notice.

`npm ci` still reports one high-severity transitive audit issue (brace-expansion in
the Pi development tree). No blind dependency upgrade/audit fix was applied;
review before release. The package is **0.1.0**, remains private, and has no release
tag. Pre-v1 compatibility is not promised; v1.0.0 is reserved for the first real
product, not an implementation-scope label.

## First owner-confirmed live dictation

After explicit local-server configuration and container client provisioning, the
owner confirmed the first live dictation worked as expected. Confirmation covered
text remaining in the editor until manual submission and intact first/last spoken
words. Correction was disabled for this check. No dictated text or audio is retained
in these engineering notes or fixtures.

This establishes one initial live transcription/draft-delivery success in the
owner's current environment, not the broader hardware/provider/interaction matrix.

## Source-dialog and feedback regression checks

**196 tests and typecheck pass** after extending the test-only native fixture with
real Pi source dialogs, widget containers and stock footer rendering. Agent/session
stats and footer data remain synthetic; no Git watcher, audio or provider is used.
Production still imports only public APIs.

New checks exercise temporary source choices, explicit source-only persistence,
default restoration and immutable active routing with a real temporary ConfigStore.
Native dialog Enter is not prompt submission; dialog Escape restores typing focus
without aborting the agent or dictation. Delivery behind an open source dialog
preserves its focus and appends only to the main draft. Shutdown closes the dialog;
the real public ExtensionRunner can invalidate before its old command settles
without permitting a stale choice/write/notice.

Native regular/fullscreen stock and replacement-footers are rendered at 12/20/80
columns. Every measured line fits, REC remains in the above-editor widget, the
replacement footer is untouched and cancellation clears owned feedback. This is
synthetic renderer evidence, not the full live/compositor layout matrix.

Three new failing regression tests led to fixes: reject duplicate source `--save`
flags before any mutation, re-evaluate phase colors after theme changes during
processing, and suppress false editor-loss discard notices after result work has
already finished but recorder cleanup remains held. The existing one-second
ownership timer refreshes only changed text, avoiding repeated widget replacement
when the phase/theme is unchanged. See the [live checklist](docs/validation.md)
for owner-driven checks without retaining private test content.

## Remaining unvalidated acceptance

- Broader live reload, command/status/source-save/dialog interaction, microphone
  and speech-tail checks; physical terminal/tmux F8 variants and collisions. The
  first basic dictation/draft/manual-submit check passed as reported above.
- Live busy-agent/compaction/navigation/auth/reload behavior and semantic
  clipboard/image-provider preservation in a full interactive Pi session.
- Stock/narrow/replacement footer and optional compositor visibility/layout.
- Normal/boxed audio, local/remote STT/auth and ordered correction-provider matrix;
  correction quality, domain vocabulary, context disambiguation and data-injection
  resilience. JSON isolation is not proof of semantic resistance.
- Node 22.19 live validation and later Pi compatibility. API declaration coverage
  and a Node 26 fixture run are not evidence for every supported environment.

No real audio, transcript, credentials or user configuration are test fixtures.
