# pi-oaistt
<!-- vim: set textwidth=72 expandtab: -->

Speech-to-text dictation and context-aware draft correction for Pi.

The Pi counterpart to [oaistt.nvim](https://github.com/7h145/oaistt.nvim):
dictate, correct, and review text without leaving Pi's prompt editor.

<!-- TOC -->

- [What this is](#what-this-is)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Correction](#correction)
- [Configuration](#configuration)
  - [Full configuration and defaults](#full-configuration-and-defaults)
  - [Transcription profiles](#transcription-profiles)
  - [Recorder and keys](#recorder-and-keys)
- [Context and privacy](#context-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Development and license](#development-and-license)

<!-- /TOC -->

## What this is

pi-oaistt turns speech into text in Pi's prompt editor. Press **F8** to
start recording, continue working, then press it again to transcribe and
append what you said. Review the draft, edit it if needed, and submit it
yourself. Nothing is sent to the main agent automatically.

It works with local or remote OpenAI-compatible transcription services.
Optional correction can repair likely recognition errors before a
transcription is inserted. Correction is also useful without audio:
press **F7** to clean up the current draft using bounded conversation
context to help preserve technical names, terminology, tone, and intent.

Both workflows work while the main agent is busy. Progress appears above
the editor and in compatible footers. **F12** cancels pi-oaistt without
aborting the main agent; Escape keeps its normal Pi behavior.

## Requirements

- Pi's interactive terminal UI with the stock editor.
- Node.js 22.19 or newer.
- For dictation:
  - Linux with PulseAudio or a PipeWire-Pulse-compatible service;
  - `pactl` and `parecord` (`pulseaudio-utils` on Debian-family systems);
  - a working, unmuted microphone accessible to the Pi process;
  - a reachable OpenAI-compatible audio transcription service.
- For correction: a model registered in Pi with usable credentials.
- An API key when the selected transcription service requires one.

Version 0.2.0 is pre-1.0. The tested Pi API baseline is **0.99.2**; the
live hardware/provider matrix is still being validated. See the
[validation checklist](docs/validation.md) for outstanding checks.

Dictation and draft correction require the terminal editor, not RPC,
print, or JSON mode. pi-oaistt does not compose with another custom
editor.

In a containerized (or “boxed”) setup, Pi runs inside a container; see
[piinabox](https://github.com/7h145/piinabox). Audio access needs explicit
host approval. Read [Context and privacy](#context-and-privacy) before
sharing an audio socket.

## Installation

Install for your Pi sessions from GitHub:

```sh
pi install git:github.com/7h145/pi-oaistt
```

This is a personal/global install. Add `-l` for a project-local install.
Run Pi's **`/reload`** if Pi is already running.

To try a local checkout without installing it, run from its root:

```sh
pi -e ./index.ts
```

Do not load both the installed and checkout copies. Disable the installed
copy with `pi config`, or use `pi --no-extensions -e ./index.ts` for an
isolated run. Pi supplies the runtime modules; no build step is needed.
Loading the extension does not open the microphone or contact a provider.

## Usage

### Dictation

Without transcription configuration, pi-oaistt uses OpenAI's `whisper-1`
model. Set its API key in the environment that starts Pi:

```sh
export OPENAI_API_KEY="..."
pi
```

This transcription key is separate from Pi's chat-provider `/login`.
For a local service, configure a [transcription profile](#transcription-profiles)
instead.

1. Press **F8** and wait for **`● REC`** before speaking.
2. Speak, then press **F8** again to stop and transcribe.
3. Wait for the text to appear in the draft. Review it before submitting.

You may keep typing while dictation runs. The result appends to the latest
draft, not the cursor position, without replacing existing text. Press
**F12** to discard an active recording or request. Submitting a prompt,
changing session/editor, or running full Pi `/reload` also discards an
unfinished result rather than inserting it into a different draft.

The main controls are:

| Default key | Action |
| --- | --- |
| **F8** | Start recording, or stop an active recording and use it |
| **F7** | Correct the current draft without recording |
| **F12** | Cancel pi-oaistt only |

Equivalent dictation and cancellation commands are:

```text
/oaistt dictation toggle
/oaistt dictation start
/oaistt dictation stop
/oaistt cancel
```

Bare **`/oaistt`** shows concise help and status; it does not start recording.
Use **`/oaistt help`** for commands, aliases, default/active shortcuts, and
pending key changes. **`/oaistt status`** shows the current operation and
next selections without the command list.

Only one dictation or correction operation runs at a time. Pressing F8
while transcription, correction, or cleanup is underway reports the
phase rather than starting another recording.

### Correct a draft

After [choosing correction models](#correction), press **F7** with a draft
in the editor. The result replaces the whole draft directly and can be
undone with Pi's normal undo control. Identical output makes no undo entry.

If you type, paste, attach content, or otherwise change the draft while
waiting, correction is cancelled instead of overwriting your edits—even
if you later undo the change. Moving the cursor or changing focus alone
does not cancel it. Failure leaves the draft untouched; nothing is
submitted or restored over a newer draft.

F7 works independently of automatic dictation correction. Draft correction
is invoked with F7, not a typed command.

## Correction

Correction needs at least one model in `correction.order`. This list is
empty (`[]`) by default, so no correction requests are made until you
configure it. Each model must be registered in Pi and have the credentials
its provider requires. Use `pi --list-models` to find model IDs.

`correction.automatic` controls what happens after transcription. It
defaults to `true`: pi-oaistt tries to correct the transcribed text before
appending it to your draft, using the models you configured. Set it to
`false` to insert the transcription unchanged, without a correction
request or correction-failure notice.

**F7 works independently of `correction.automatic`.** It corrects the
current draft using the same model list, whether automatic correction is
on or off. You can leave automatic correction off and still use F7 after
typing, pasting, or dictating.

**Each provider tried receives the target text and bounded conversation
history.** For dictation, the target is the new transcription, not the
existing draft. For F7, it is the entire **unsent draft**. Choose providers
appropriate for that content. To omit conversation history, set
`correction.context.maxChars` to `0`.

For example, this configuration enables automatic correction and tries
`openai-codex/gpt-6-luna` first, with the current Pi session model as an
explicit fallback. F7 uses the same list:

```json
{
  "correction": {
    "automatic": true,
    "order": [
      "openai-codex/gpt-6-luna",
      "$current"
    ]
  }
}
```

Merge this section into `pi-oaistt.json`, preserving your other settings,
then run **`/oaistt reload`**. To use this list for F7 only, change
`automatic` to `false`.

`"$current"` captures the model selected in Pi when recording or F7 starts.
Changing Pi's model later does not retarget that correction. The request
does not inherit the main agent's thinking level. If both entries resolve
to the same model, it is tried only once. Each correction starts at the
top of the list and stops at the first valid result.

`openai-codex/gpt-6-luna` is a recommended opt-in choice, not a shipped
default. Neither it nor `"$current"` is added automatically because you
have credentials, a subscription, or the default Whisper setup. Verify
that the model works for your setup; the recommendation is not live
compatibility or quality validation.

If no model succeeds—including when the list is empty—automatic dictation
inserts the raw transcription with a notice. F7 leaves the draft unchanged.
Invalid thinking settings stop correction with an error rather than
trying another model. Cancellation inserts nothing.

The model is asked for minimal edits, not an answer to the draft, and
cannot call tools. Its output can still be wrong. Review it before
submission. See the
[correction reference](docs/configuration.md#correction-thinking-and-privacy)
for per-model thinking, deadlines, context selection, and failure rules.

## Configuration

Settings live in:

```text
~/.pi/agent/pi-oaistt.json
```

If `PI_CODING_AGENT_DIR` is set, use `pi-oaistt.json` in that directory.
There is no project configuration layer. Merge the example sections into
one JSON file; unspecified settings use their defaults.

**`/oaistt reload`** applies pipeline settings to subsequent operations;
an active operation keeps its starting settings. Code and key changes
require full Pi **`/reload`**, which cancels active work. The
[configuration reference](docs/configuration.md) covers all fields,
defaults, bounds, commands, and exact aliases.

### Full configuration and defaults

This is a complete `pi-oaistt.json` with the built-in defaults. You can
copy it as a starting point; the extension does not create it for you.
Timeouts and durations are in seconds; `maxBytes` is 24 MiB.

```json
{
  "recorder": {
    "backend": "parecord",
    "source": null,
    "maxDurationSeconds": 300,
    "maxBytes": 25165824,
    "stopTimeoutSeconds": 3
  },
  "transcription": {
    "order": ["openai"],
    "profiles": {
      "openai": {
        "endpoint": "https://api.openai.com/v1/audio/transcriptions",
        "model": "whisper-1",
        "auth": {
          "type": "env",
          "name": "OPENAI_API_KEY"
        }
      }
    },
    "defaults": {
      "language": null,
      "attemptTimeoutSeconds": 60
    },
    "automaticFallback": false,
    "totalTimeoutSeconds": 120
  },
  "correction": {
    "automatic": true,
    "order": [],
    "modelSettings": {},
    "defaults": {
      "thinkingLevel": null,
      "attemptTimeoutSeconds": 15
    },
    "context": {
      "maxChars": 8000
    },
    "totalTimeoutSeconds": 30
  },
  "delivery": {
    "dictationMarker": false
  },
  "keybindings": {
    "dictation.toggle": "f8",
    "dictation.start": [],
    "dictation.stop": [],
    "editor.correct": "f7",
    "operation.cancel": "f12"
  }
}
```

- `source: null` follows the audio server's recording default.
- `language: null` omits the language field from transcription requests.
- Although `correction.automatic` defaults to `true`, the empty `order`
  means no correction requests are made until you choose models.
- `thinkingLevel: null` means no correction-specific override, not a
  guarantee that the provider disables thinking.
- Profiles inherit transcription `defaults`; named `modelSettings`
  entries inherit correction `defaults`. Individual entries can override
  those tuning values without adding another active candidate.
- The optional `dictationMarker` prefixes `this is dictated` and a blank
  line only when dictation is delivered into a truly empty draft. It
  never enters correction input or comes from F7.

### Transcription profiles

A profile names an endpoint, model, and authentication policy. For an
intentionally unauthenticated local service, replace the transcription
section with this example, adjusting the endpoint and model:

```json
{
  "transcription": {
    "order": ["local"],
    "profiles": {
      "local": {
        "endpoint": "http://127.0.0.1:9000/v1/audio/transcriptions",
        "model": "YOUR_STT_MODEL",
        "auth": { "type": "none" }
      }
    }
  }
}
```

For a service requiring a key, use an environment reference such as
`{"type":"env","name":"STT_API_KEY"}`. Secrets do not belong in the
configuration file. Each profile must specify its own endpoint, model,
and auth; a present transcription section must include `order` and
`profiles`.

Only names listed in `order` are active. List or select them with:

```text
/oaistt transcription list
/oaistt transcription source local
/oaistt transcription source local --save
```

Selection without `--save` lasts for the extension runtime. Saving moves
the selected name to the front of the configured order. An active
recording keeps its original selection.

Automatic transcription fallback is **off by default**: one selected
profile is attempted. Setting `transcription.automaticFallback` to `true`
**authorizes uploading the same audio to following profiles** on failure,
with no wrap to earlier entries. Successful profiles are remembered for
later dictation until you choose or reload settings; this never saves
configuration automatically.

### Recorder and keys

Recording uses the audio server's default microphone unless you choose
an override. Inspect sources or select one for future recordings with:

```text
/oaistt recorder sources
/oaistt recorder source NAME
/oaistt recorder source default
```

Add `--save` to persist an explicit selection. These commands do not
change the host's default input, mute, or volume. Default/null follows
the server's recording default, not `PULSE_SOURCE`. See
[recorder setup](docs/configuration.md#recorder-and-container-audio) for bounds
and container requirements.

To change shortcuts, add a `keybindings` section, for example:

```json
{
  "keybindings": {
    "dictation.toggle": ["f8", "f9"],
    "editor.correct": "f6",
    "operation.cancel": "f12"
  }
}
```

A string binds one key, an array binds several, and `[]` disables an
action. Run full Pi **`/reload`** to apply key changes, then check
`/oaistt help` for active mappings and conflicts.

## Context and privacy

The selected transcription service receives **audio**. Correction
providers receive **text and bounded history** and may differ from the
main agent's provider. For local-only use, select local transcription
and correction models explicitly.

Correction context comes from Pi's compaction-aware active branch. It
includes recent user/assistant text and eligible summaries, but excludes
direct tool calls/results, images, thinking, shell output, and custom
messages. Text and summaries can still contain sensitive information;
this is not redaction. Set `correction.context.maxChars` to `0` to omit
conversation history. Dictation correction does not include the existing
editor draft; F7 deliberately does.

pi-oaistt keeps no audio, transcript, or credential logs. Temporary audio
is deleted after completion or cancellation; crashes can prevent cleanup.
Cancellation cannot recall transmitted data or guarantee deletion at a
provider. Avoid raw provider or terminal tracing with sensitive content.

**Containers:** an approved Pulse socket can grant broad host audio
access and control, not microphone-only permission. A read-only bind
mount does not make the audio protocol read-only. pi-oaistt does not
mount sockets, start host services, or change host audio settings.
Access to a transcription server is separate from microphone access.

## Troubleshooting

Start with **`/oaistt status`** and **`/oaistt help`**. A ready notice
confirms loading, not microphone capture, credentials, or provider health.

- **Missing audio tools:** on Debian-family systems, install `pulseaudio-utils`
  where Pi runs, then retry. The extension never installs packages.
- **No REC or no usable audio:** check `pactl`/`parecord` availability,
  server access, microphone permission, and the selected source. Muted,
  missing, and playback-monitor sources are rejected; another input is
  not guessed automatically.
- **Transcription fails:** verify the full endpoint, model, and explicit
  auth policy. Environment keys must be available to the process that
  started Pi. Redirects and responses without nonempty JSON `text` are
  rejected.
- **F7 does nothing useful:** configure a nonempty correction order,
  check model credentials, and inspect any thinking error. Manual
  correction does not need recorder or transcription credentials.
- **Keys do not arrive:** check terminal/tmux interception and Pi's
  shortcut warnings. Rebind keys if needed. Native conflicts are disabled;
  conflicts with other extensions follow Pi's priority rules.
- **Settings do not apply:** use `/oaistt reload` for pipeline settings,
  full `/reload` for code/keys, and check settings against the
  [configuration reference](docs/configuration.md).
- **Another editor is installed:** restore the stock editor and reload.
  Paste display may expand on editor transfer; editor replacement can
  change undo history.

## Development and license

From a checkout:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

[GitHub Actions CI](.github/workflows/ci.yml) runs typechecking and the
synthetic test suite on Linux with Node 22.19.0 and 24, for pushes and pull
requests (or manually). It needs no microphone, audio server or provider
credentials; it does not replace live acceptance.

See [DEVELOPMENT.md](DEVELOPMENT.md) for engineering evidence and
[docs/validation.md](docs/validation.md) for live acceptance checks.

See also [pi-lazy](https://github.com/7h145/pi-assorted/tree/main/extensions/pi-lazy)
for a separate Pi draft-correction extension.

pi-oaistt is licensed under the [MIT License](LICENSE). Source headers
credit thias and OpenAI Codex (gpt-6.1-sol).
