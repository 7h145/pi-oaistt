# Working with pi-oaistt

This guide explains how the extension is structured and where to change its
recording, transcription, correction and editor integration. For everyday use,
start with the [README](README.md). Configuration fields, commands and bounds are
in the [configuration reference](docs/configuration.md).

## Use a checkout

You need Node **22.19.0 or newer**. Install the locked development dependencies:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

`check` typechecks without emitting files. `test` runs TypeScript directly through
Node's built-in test runner. Its fixtures use synthetic inputs, controlled child
processes, loopback HTTP servers and simulated providers; no microphone or provider
credentials are required. Git is needed for the Git integration fixtures.

Development dependencies pin Pi **0.99.2**. Pi supplies the runtime peer modules
when loading the extension, and production imports use its public package exports.
There is no build step. From the checkout root, load it with:

```sh
pi -e ./index.ts
```

Do not also load an installed copy. Disable that copy through `pi config`, or use
`pi --no-extensions -e ./index.ts` to load only the checkout. Full Pi `/reload`
reloads code and shortcuts and cancels active work. `/oaistt reload` reloads
settings for subsequent operations, without retargeting work already running.

## Source map

| File | Responsibility |
| --- | --- |
| `index.ts` | Pi extension entry point |
| `src/extension.ts` | Commands, shortcuts, session lifecycle, pipeline wiring and above-editor feedback |
| `src/operation.ts` | Dictation/manual correction lifecycle, deadlines, cancellation and recorder cleanup |
| `src/editor.ts` | Native editor adapter, prompt-capture observation and draft revisions |
| `src/draft.ts` | Guard against inserting a result twice or into a draft it no longer belongs to |
| `src/recorder.ts` | PulseAudio/PipeWire-Pulse queries, `parecord` capture and private temporary files |
| `src/wav.ts` | WAV format and size validation |
| `src/transcription.ts` | Audio preparation, bounded HTTP requests and ordered STT fallback |
| `src/correction.ts` | Conversation context, correction prompts, Pi model requests and response validation |
| `src/profiles.ts`, `src/correction-selection.ts` | Temporary selections, remembered successes and newer-choice precedence |
| `src/config.ts` | Configuration parsing, immutable snapshots and explicit saves |
| `src/keys.ts` | Action names, binding defaults, key validation and native conflicts |
| `src/version.ts` | Installation identity for interactive status |

## Adapt the extension

### Configure before changing code

A different OpenAI-compatible transcription service usually needs only a profile.
Correction models, tuning, history budget, microphone selection and shortcuts are
also configurable. Use the [configuration reference](docs/configuration.md) before
changing implementation defaults.

### Recording and transcription

The `Pipeline` interface in `src/operation.ts` separates recording, transcription
and correction from operation control. `registerDictation()` in `src/extension.ts`
wires these stages and accepts dependency overrides for a customized checkout.

A recorder returns a `Recording` handle synchronously, before startup finishes.
The handle owns startup resources immediately; `ready` resolves when audio bytes
have arrived, `stop()` produces an `AudioFile` containing the private file path
and byte count, and `dispose()` performs bounded, idempotent cleanup even after
interrupted startup. The audio must be finalized mono PCM16 at 16 kHz in a RIFF WAV
file, as required by `src/wav.ts`. A replacement recorder must preserve these
format and lifecycle requirements, not merely return a file when its process exits.
The configuration parser currently accepts only the `parecord` backend; another
configured backend also needs matching parser and wiring changes.

The transcription client prepares and validates audio before upload. It sends
fresh multipart bodies containing the same validated WAV for each authorized
attempt, and accepts nonempty JSON `text`. For a service with a different protocol,
change the request/response adapter while retaining explicit authentication,
bounded input and output, cancellation, deadlines and safe failure categories.
Do not let a redirect or an adapter error introduce an unconfigured destination.

### Correction behavior

`src/correction.ts` composes each prompt from shared wording, context and output
rules plus workflow-specific formatting rules. F7 uses
`MANUAL_CORRECTION_PROMPT` to preserve intentional formatting and outer whitespace.
Post-transcription correction uses `STT_CORRECTION_PROMPT` to repair recognition
and layout errors. Its output is trimmed; manual output retains outer whitespace.

The workflow selects its mode and prompt once, from trusted operation metadata,
and keeps them across fallback attempts. Keep target text and conversation context
as data rather than allowing either to choose the mode. The model receives no
tools and is asked to edit, not answer or execute the target. These instructions
cannot guarantee correct model output; users still need to review the draft.

`correct()` returns a corrected result, ordinary exhaustion (no model succeeds),
or a local thinking policy error. Ordinary exhaustion inserts the uncorrected
transcription with a notice, or leaves a manual draft unchanged. A thinking policy
error gives the same uncorrected/unchanged text but reports an error instead of
an exhaustion notice. Cancellation delivers nothing and must not be treated as
ordinary exhaustion.

### Controls and presentation

Action names, defaults and native conflict checks live in `src/keys.ts`.
Registration, command parsing, help, status and progress rendering live in
`src/extension.ts`. Keep displayed shortcuts tied to active bindings, not pending
configuration or assumed defaults.

Progress uses one widget above the editor and does not modify the footer. Help,
status and settings-reload responses each use one composed notification: Pi can
coalesce consecutive informational notices. Selection lists expose exact command
arguments; status explains the next operation's choices. Neither display probes
provider availability.

## Operation and editor boundaries

### One operation, independently cancelled

`OperationController` owns either dictation or manual correction. Each operation
captures immutable settings and its model identity and has its own abort
controller. A `DraftLease` allows one insertion while the result still belongs
to that draft; cancellation invalidates it. The operation never submits a prompt
or aborts the main agent.

Prompt capture, session/navigation changes, editor takeover and full reload
invalidate unfinished work. Completion checks revalidate ownership and monotonic
deadlines before another provider request or editor write, including when a
provider ignores its abort signal. Recorder ownership remains held if cleanup
fails, preventing a second capture from starting over unfinished cleanup.

### Observe capture before Pi consumes the prompt

`DictationEditor` extends Pi's public `CustomEditor`. It observes submit and
follow-up callbacks and synchronously invalidates delivery before forwarding the
native callback, including busy-agent and compaction paths. Do not replace this
with a raw Enter handler: autocomplete and dialogs also use Enter. A later input
event or UI timer is too late to guard prompt capture.

The adapter reads expanded semantic text for transfer and delivery, preserving
pasted content and attachment/path references rather than copying only their
collapsed display. Dictation appends to the latest draft. Manual correction
replaces only its captured, still-owned draft; any content change cancels it,
even if undone later. Cursor and focus changes alone do not cancel correction.
Native setters provide undo, and identical manual output creates no undo entry.

### Require the default editor

Pi has one active editor factory; it does not automatically compose independently
written editors. pi-oaistt therefore requires the default editor when installing
its adapter and refuses delivery after another editor takes over. Wrapping an
arbitrary editor cannot ensure correct prompt capture, draft revisions, semantic
paste transfer or undo. A customized integration needs deliberate cooperation
with that editor, not removal of the ownership check alone.

Full reload transfers expanded text, but replacing the editor can expand collapsed
paste blocks and does not promise to preserve the previous editor's undo history.

## Settings and provider boundaries

Settings and selected identities stay frozen for an operation. A temporary
selection affects the next operation; a successful fallback can become its next
starting point. If the user selects, reselects, saves or reloads settings after
an operation begins, its later success cannot override that newer preference.
The operation still uses its starting settings. F7 and dictation share the
remembered correction selector. Automatic fallback never writes configuration.

Transcription fallback requires explicit opt-in and tries only the selected
profile and following active entries, without wrapping. Correction likewise uses
only explicitly ordered selectors and following entries. An eligible `$current`
is resolved at operation start; actual correction identities are deduplicated.
Available credentials or tuning entries outside the order never authorize another
model. Settings reload resets profile/model choices to their saved first entries.

`ConfigStore` serializes explicit saves through Pi's file mutation queue, rereads
and validates the file, preserves unrelated fields, and replaces it atomically
with private permissions. This is not a cross-process filesystem lock. Loading
defaults, listing choices and making temporary selections never writes settings;
only an explicit save creates or replaces the file.

Audio stays in private temporary storage and is uploaded only after valid
finalization; forced-stop or invalid audio is discarded. Cleanup deletes temporary
files, although crashes can prevent it. Recorder commands do not change host
routing, defaults, mute or volume. In containers, microphone access and provider
network access remain separate permissions; a shared Pulse socket can grant broad
host audio control, even through a read-only filesystem mount.

Correction uses Pi's model routing and credentials without creating an agent turn
or inheriting main-agent thinking settings. One bounded active-branch snapshot
supplies eligible user/assistant text and summaries, excluding direct tool content,
images, thinking, shell output and custom messages. F7 targets the unsent draft,
not attachment contents; dictation targets only its new transcript. Context can
be disabled, but excluding message types does not redact sensitive text. The
request encodes context and target as JSON fields; this does not guarantee that
the model ignores instructions within them.

Keep audio, transcripts, credentials, private paths, response bodies and raw
provider errors out of diagnostics. Use bounded labels and static failure
categories. Cancellation cannot recall data already sent or guarantee deletion
at the receiving provider.
