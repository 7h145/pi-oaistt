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
configuration or real provider credentials are required for tests.

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

One bounded committed active-branch snapshot supplies eligible user/assistant text
and summaries, excluding direct tools, images, thinking, shell and custom messages.
History can be disabled. Dictation targets only the transcript; F7 targets the
captured unsent draft, not attachment file contents. Requests have no tools, use
isolated target/context data, and reuse the snapshot across attempts. JSON isolation
is not proof of semantic resistance to adversarial text.

Ordinary correction exhaustion gives guarded raw dictation plus a notice or leaves
manual drafts unchanged. Invalid thinking policy stops locally with a red error;
unused later tuning cannot reject an earlier success. Cancellation gives no result.

### Configuration and UI

Only the current fields, commands and exact aliases are accepted. Invalid routing
cannot silently inherit an endpoint or authorize a fallback. Binding faults are
localized; Pi's cross-extension registration priority is not universal conflict
detection. Key changes require full reload.

Source/profile saves serialize read/validate/modify/private atomic replacement
through Pi's public file mutation queue, preserving unrelated fields. Defaults,
listing and temporary choices do not write configuration.

Feedback uses public status/widget APIs without replacing the footer. Each help,
status or settings-reload response is one composed notification so consecutive
informational notices cannot hide command help or pending bindings. Profile tools
expose bounded selection metadata, not audio, drafts, endpoints or credentials;
non-TUI metadata does not enable recording or editor access.

## Automated evidence

**327 synthetic tests and typechecking pass** against Pi 0.99.2. Clean temporary
installs pass on Node 22.19.0/npm 10.9.9 and Node 24.21.0/npm 11.21.0; the suite also
passes in the Node 26.10.0 development environment.

| Area | Coverage |
| --- | --- |
| Editor/ownership | Native regular/fullscreen, idle/busy/compaction capture, semantic paste/references/undo, eager manual edit cancellation, cursor/focus, no-op output, late completion and retained cleanup |
| Correction | Automatic/manual with empty/configured/unavailable order, frozen current identity and deduplication, tuning/null/thinking errors, auth-ready empty-order non-dispatch, deadlines, context exclusions and immutable requests |
| STT | Explicit consent, active/inactive profiles, following-only fallback, fresh bodies over identical WAV, auth/response/timeout/size failures and newer-choice races |
| Config/save | Strict unknown-field and malformed-input rejection, snapshots, private file mode, source/profile queue transactions, no implicit writes and failed reload behavior |
| UI/keys/tools | Native F7/F8/F12 dispatch, main Escape, help/status rendering, bounded metadata, narrow/theme/footer layouts, pending keys and exact aliases |
| Loader/reload | Public discovery/jiti/runner, reset-before-shutdown, fresh-runtime key registration and semantic editor transfer |
| Documentation | Runnable JSON examples, exact default settings and explicit example order |

Recorder fixtures spawn detached Node children emitting synthetic PCM, not actual
recorders. HTTP tests use controlled synthetic responses or loopback servers;
faux providers disable external HTTP. No real audio, transcripts, credentials or
private user configuration are fixtures or logs.

The native UI fixture has test-only access to private host wiring to isolate
callbacks, while production stays public-only. It resolves TUI/keybindings from
Pi's own module tree to avoid split global registries. Agent/auth and unrelated
panels are synthetic: these tests are not a complete live Pi session or reload.

## Live acceptance

The owner confirms help works as expected on their setup. Exact layout, aliases
and root/status coverage were not reported, so this is not universal UI acceptance.
A GitHub-hosted CI run was reported started; its outcome has not been verified in
this development record.

Remaining acceptance includes microphone first/last words and timing, actual
STT/auth routes, correction quality and thinking controls, physical terminal/tmux
shortcuts, busy/compaction/navigation/reload, clipboard/image references, and
stock/replacement/compositor layouts. Test normal Linux and containerized (or
“boxed”) setups, where Pi runs inside a container; see
[piinabox](https://github.com/7h145/piinabox). Container audio requires explicit
host approval and is separate from provider networking.

Use the [live checklist](docs/validation.md). Record coarse pass/fail, versions,
phase and timing only; do not retain audio, transcripts, credentials or private
configuration. Source inspection, synthetic tests and live observations remain
separate evidence categories. Passing one route does not fill the entire matrix.

TTS, direct streaming transcription, tool-derived glossaries and general custom
editor composition are outside the implemented scope. Review pinned dependency
security before release rather than applying untested blanket upgrades.
