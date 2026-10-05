# Development and verification

## Interface policy during v0.*

During pre-v1 development, backward compatibility and interface stability are
not design goals. Prefer clean, correct and useful interfaces and documentation;
do not retain aliases, shims or automatic configuration conversion for earlier
interfaces. Unknown fields and unsupported syntax are rejected.

Product documentation describes the current state only. It contains no interface
history or migration guides. A user can ask an agent to fix a configuration using
the current reference; this does not authorize unsolicited private-file changes.
Reconsider this policy at v1.* at the latest, or earlier if explicitly decided.
Privacy, cancellation and editor-ownership guarantees remain requirements.

## Development setup

The implementation and native API tests target **Pi 0.99.2**. Node **22.19.0 or
newer** is required; Node's TypeScript stripping runs the `.ts` tests directly.
From a checkout:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The lockfile pins development dependencies. Dependency lifecycle scripts are not
needed for the synthetic suite. Production imports use Pi's public root exports;
Pi supplies runtime peer modules to loaded extensions. No microphone, personal
configuration or real provider credentials are required for tests. Synthetic Git
integration fixtures require the Git client; Git is optional at runtime.

[GitHub Actions CI](.github/workflows/ci.yml) runs locked installs, typechecking
and tests on Ubuntu with Node 22.19.0 and 24. It isolates Pi settings in temporary
storage, uses read-only permissions and SHA-pinned actions, and does not retain
checkout credentials. CI is not live hardware/provider acceptance.

## Safety architecture

### Editor ownership and prompt capture

A public `CustomEditor` subclass observes actual prompt capture through Pi's
submit and follow-up callbacks. It invalidates the delivery lease synchronously
before delegating capture, including busy-agent and compaction paths. It does not
intercept every Enter key or submit a prompt itself.

The adapter uses semantic expanded text for editor transfer and delivery. Append
preserves intervening typing, multiline paste and attachment/path references;
manual correction replaces only the captured draft while its revision remains
owned. Native setters provide undo. Identical manual output makes no undo entry.
Cursor/focus changes alone do not invalidate manual correction; content changes,
including edit-and-revert, do.

Editor replacement is not seamless undo-history transfer. The adapter refuses to
replace another custom editor, and refuses delivery after an editor takeover.
Full reload restores semantic text but may change editor instance/history.

### Owned operations and cleanup

One shared controller owns either dictation or manual correction. Each operation
captures immutable settings and model identity, owns its abort controller and
never uses the main-agent signal. Submit, navigation, editor replacement and full
reload discard unfinished work. Settings-only reload affects subsequent work.
Cancellation never submits, aborts the main agent, restores a stale draft or
inserts a raw fallback.

Recorder ownership remains held until cleanup succeeds. Startup is distinct from
REC readiness; stop/cleanup failures cannot silently permit a second recorder.
Completion checks revalidate ownership and monotonic deadlines before another
provider request or editor write, even when a provider ignores abort.

### Recorder and provider boundaries

The Linux recorder uses `parecord` with PulseAudio/PipeWire-Pulse. Resolve the
server recording default at capture start, or use the explicit source override;
`PULSE_SOURCE` is not an override. Reject muted, missing and monitor sources.
No host defaults, volume or routing are changed.

Recording first probes `pactl`/`parecord` with bounded, cancellable `--version`
requests. Missing tools get a short `pulseaudio-utils` package hint, separate from
server or executable-access failures. No package installation or startup probing
is performed. Source-list commands preserve safe diagnostics and redact other
errors; version/query stdout and stderr are never echoed.

Audio uses private temporary storage, mono PCM16 at 16 kHz, bounded duration/size,
and validated WAV finalization. REC means audio bytes arrived, not merely that a
child started. Graceful SIGINT timeout escalates only the owned detached process
group; forced-stop or invalid audio is never uploaded. Exact digital silence is
rejected without treating quiet speech as silence.

STT profiles explicitly define endpoint/model/auth. Ordered fallback is opt-in,
following-only and no-wrap, using fresh multipart bodies over the same validated
WAV. Successful profile preference is process-local; newer user choices or reloads
win over held success. Only explicit saves write preferences to configuration.

Correction uses only explicitly ordered Pi model identities, including an explicit
`$current` selector frozen at operation start. Resolve duplicates at first position
and restart the order for every operation. The automatic switch never authorizes
a model, and F7 uses the same order independently. Pi owns routing/credentials;
correction does not inherit main-agent thinking settings or start an agent turn.

Temperature tuning defaults to null: no request option for any API. Section
`defaults` and actual-model `modelSettings` share finite nonnegative numeric
validation; omitted entries inherit, explicit null clears, and zero is preserved.
Overrides are forwarded to Pi without guessing provider support or silently
rewriting values. Tests can verify option construction without proving live
adapter/backend acceptance. Per-operation snapshots freeze this tuning too.

One bounded committed active-branch snapshot supplies eligible user/assistant text
and summaries, excluding direct tools, images, thinking, shell and custom messages.
History can be disabled. Dictation targets only the transcript; F7 targets the
captured unsent draft, not attachment file contents. Requests have no tools, use
isolated target/context data, and reuse the snapshot across attempts. JSON isolation
is not proof of semantic resistance to adversarial text.

Ordinary correction exhaustion gives guarded raw dictation plus a notice or leaves
manual drafts unchanged. Invalid thinking policy stops locally with a red error;
unused later tuning cannot reject an earlier success. Cancellation gives no result.
Fallback warnings distinguish provider failure, truncated/aborted/incomplete
responses, empty output, tool calls, oversized output and invalid text using
static categories, never response content or raw provider errors.

### Configuration and UI

Only the current fields, commands and exact aliases are accepted. Invalid routing
cannot silently inherit an endpoint or authorize a fallback. Binding faults are
localized; Pi's cross-extension registration priority is not universal conflict
detection. Key changes require full reload.

Source/profile saves serialize read/validate/modify/private atomic replacement
through Pi's public file mutation queue, preserving unrelated fields. Defaults,
listing and temporary choices do not write configuration.

Progress uses one public above-editor widget; footer APIs are not used. Each help,
status or settings-reload response is one composed notification so consecutive
informational notices cannot hide command help or pending bindings. Profile tools
expose bounded selection metadata, not audio, drafts, endpoints or credentials;
non-TUI metadata does not enable recording or editor access.

Help leads with an introduction/active controls, then grouped commands and shared
notes, using muted text and bold `text` highlights. Its first-model preview does
not probe availability. Help stands alone; bare root and status are identical.
Owner-approved `transcription profile NAME [--save]` / `t p` supersedes the handoff
spelling, without compatibility aliases or changed safety/selection behavior.
Recorder `sources` / `source` retain PulseAudio terminology.

Startup is a muted orientation line with bold `text` title/keys and dot separators,
not readiness. Active toggle wins; otherwise both start/stop keys are required.
Recording shares hint formatting but needs only a stop key when toggle is absent:
`● REC 00:05 · oaistt · F8 stop · F12 cancel`. Only REC/timer is red; guidance is
muted with bold neutral brand/keys. Cancellation is independent; unbound/conflicting
hints are omitted, all-unbound keeps REC/brand, and pending keys cannot change hints.
Pi owns wrapping/clipping. Existing timers, theme refresh and owned clearing remain;
no process/probe is added. Start/correction hints never appear during recording.

Status shares the muted/neutral-bold palette and uses ordered profile/model/key
bullet lists. Only the first candidate is bold, not a proven usable/live selection.
STT preview and dispatch share following-only candidate derivation: from the
process-selected profile, no wrap, single candidate when fallback is off.
Correction previews the configured order, resolving an explicit `$current` without
registry/auth probes. Operation identities stay frozen; status previews subsequent
work. Capture device is the bounded/control-stripped frozen dictation source,
otherwise current settings, without audio queries. Missing state is unavailable;
the configuration statement confirms loading only, not resource readiness.
Pending keys retain full-reload/conflict guidance. Each response is one notice.
These owner-approved root/help semantics supersede the handoff's concise root help.

Identity is cached at interactive session start from the package manifest and an
optional bounded read-only package-root Git HEAD query. No parent lookup, ambient
Git overrides/config or trace output; import/factory, non-TUI startup and later
status calls do not probe. Git failure retains version-only status; missing
metadata cannot block controls. A hash names HEAD, not a clean/immutable build.

## Automated evidence

**Latest full baseline: 492 synthetic tests and typechecking pass** against Pi
0.99.2 on Node 22.19.0/24.21.0, with isolated settings. Native UI tests cover
separate help/root-status identity, effective STT order/bold starts, neutral lists,
missing state, pending keys and read-only active ownership. Recording covers 14
binding scenarios in regular/fullscreen, segmented colors, elapsed/theme refresh,
pending-key stability and processing/clearing. Footer-write guards and stock/custom
footer snapshots verify no footer changes, including unrelated extension statuses.
No live widget-only-placement test or host Pi 1.0.2 requalification is claimed.

Profile commands cover both forms, temporary/save/no-name/rejected syntax, frozen
settings and newer-choice races. Installed identity covers optional/malformed
metadata, package-root Git/worktrees, symlinks, ambient overrides, bounded hangs,
caching/non-TUI non-probing and native discovery/jiti. Startup covers rebound,
multiple/unbound/conflicting keys and toggle/pair precedence. Native layouts cover
32/40/80/120 columns, with existing feedback cases at 12/20/80.

Successful recorder fixtures use the production-sized three-second grace budget;
deliberate hung-stop fixtures retain a short deadline. Production timeouts are
unchanged. Delayed-finalization coverage and repeated-stop checks address the
fixture scheduling sensitivity observed in hosted Node 24 CI. The latest full
local matrix passes, but a hosted rerun is still needed for CI confirmation.

| Area | Coverage |
| --- | --- |
| Editor/ownership | Native regular/fullscreen, idle/busy/compaction capture, semantic paste/references/undo, eager manual edit cancellation, cursor/focus, no-op output, late completion and retained cleanup |
| Correction | Automatic/manual with empty/configured/unavailable order, frozen current identity and deduplication, tuning/null/thinking errors, nullable temperature inheritance/overrides and request omission, auth-ready empty-order non-dispatch, deadlines, context exclusions and immutable requests |
| Recorder | Missing tool subsets, executable-access faults, cancellation, isolated PATH lookup with fake clients, redacted server failures and owned capture/cleanup |
| STT | Explicit consent, active/inactive profiles, following-only fallback, fresh bodies over identical WAV, auth/response/timeout/size failures and newer-choice races |
| Config/save | Strict unknown-field and malformed-input rejection, snapshots, private file mode, source/profile queue transactions, no implicit writes and failed reload behavior |
| UI/keys/tools | Native F7/F8/F12 dispatch, main Escape, coalesced help/status rendering, neutral list-based sections and candidate identities, scoped fallback, no model probes, frozen-versus-next selection, bounded metadata, widget layouts/themes and footer noninterference, pending keys and exact aliases |
| Loader/reload | Public discovery/jiti/runner, reset-before-shutdown, fresh-runtime key registration and semantic editor transfer |
| Documentation | Runnable JSON examples, exact default settings and explicit example order |

The owner confirms the nullable-temperature configuration works as expected:
Codex correction succeeds without an override; explicitly setting
`correction.defaults.temperature` to zero restores the failing behavior on their
route. This is a live A/B confirmation of request compatibility, not proof for
all provider/model sampling overrides. Anthropic is not live-validated.

Recorder fixtures spawn detached Node children emitting synthetic PCM, not actual
recorders. HTTP tests use controlled synthetic responses or loopback servers;
faux providers disable external HTTP. No real audio, transcripts, credentials or
private user configuration are fixtures or logs.

The native UI fixture has test-only access to private host wiring to isolate
callbacks, while production stays public-only. It resolves TUI/keybindings from
Pi's own module tree to avoid split global registries. Agent/auth and unrelated
panels are synthetic: these tests are not a complete live Pi session or reload.

## Live acceptance

The owner reports roughly **100 capture/correction runs** and accepts:

- **V2 microphone capture:** works as expected, including Bluetooth; failures
  are helpful.
- **V4 correction/model quality:** acceptable; possible prompt/config tuning is
  optional, with no urgent need.
- **V7 keys/presentation:** works as expected with the owner's Neovim/tmux
  workflow. Help/status UX and recording-guidance text/behavior are owner-confirmed.

These are owner-reported live observations, not an independently measured matrix
for every provider, thinking level, terminal or widget layout. No utterances,
recordings or private configuration are retained.

| ID | Target | Current acceptance |
| --- | --- | --- |
| V1 | Installation/container setup | Fresh-install/recovery cases remain open |
| V2 | Microphone capture | Owner-accepted, including Bluetooth |
| V3 | STT/auth/fallback | Basic flow exercised; routing/auth/fallback cases remain open |
| V4 | Correction/model quality | Owner-accepted; tuning optional |
| V5 | F7/draft preservation | Clipboard/images, undo and edit-cancellation cases remain open |
| V6 | Busy/lifecycle paths | Live busy/compaction/navigation/reload cases remain open |
| V7 | Keys/presentation | Owner-accepted for Neovim/tmux workflow |
| V8 | Preferences/persistence | Live selection/fallback/save/reload cases remain open |
| V9 | CI/release hygiene | Hosted Node 24 failed; fixture fix validation and dependency review remain open |

For additional deployment coverage, distinguish normal Linux from containerized
(or “boxed”) setups, where Pi runs inside a container; see
[piinabox](https://github.com/7h145/piinabox). Container audio requires explicit
host approval and is separate from provider networking.

Use the [live checklist](docs/validation.md). Record coarse pass/fail, versions,
phase and timing only; do not retain audio, transcripts, credentials or private
configuration. Source inspection, synthetic tests and live observations remain
separate evidence categories. Passing one route does not fill the entire matrix.

TTS, direct streaming transcription, tool-derived glossaries and general custom
editor composition are outside the implemented scope. Review pinned dependency
security before release rather than applying untested blanket upgrades.
