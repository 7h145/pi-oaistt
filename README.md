# pi-oaistt

Speak a draft into Pi, then review it before sending.

**v0.1.0 — development.** The extension is now loadable for initial real-world
validation, not a finished v1 product. Pre-v1 compatibility may change. Tested API
baseline: Pi **0.99.2**, Linux interactive terminal mode; RPC/print/JSON do not
record. Real microphone, correction quality and terminal/tmux acceptance remain
in progress.

## Load a local checkout

Choose one loading method; do not load the same extension twice.

- From the checkout, start Pi with `pi --extension ./index.ts`.
- Or symlink the checkout into your project's `.pi/extensions/pi-oaistt`, then
  grant project trust and run **`/reload`**. The directory contains `index.ts` and
  a Pi package manifest. A link at `.pi/extensions/pi-oaistt` pointing to
  `../../pi-oaistt` works when the checkout is at the project root.

A short “pi-oaistt ready” notice confirms loading, **not microphone or credential
health**. Run **`/oaistt help`** or **`/oaistt status`** to check the controls.
The extension loads without opening a microphone or contacting a provider.
It requires the stock Pi editor; it will not silently replace another extension's
custom editor.

## Configure before recording

Settings belong in **`pi-oaistt.json` in Pi's configured agent directory**, not the
project directory. Without a file, transcription uses OpenAI's
`https://api.openai.com/v1/audio/transcriptions`, model `whisper-1`, and the
`OPENAI_API_KEY` environment variable. Missing required auth fails before capture.

For an intentionally unauthenticated local compatible server, use your server's
actual port/model in a configuration like this:

```json
{
  "transcription": {
    "endpoint": "http://127.0.0.1:9000/v1/audio/transcriptions",
    "model": "whisper-1",
    "apiKeyEnv": null
  },
  "correction": { "enabled": false }
}
```

After editing the file, run **`/oaistt reload`**. This reloads dictation settings,
not the extension code. It preserves temporary source overrides and does not
reroute an operation already running. See the [configuration reference](docs/configuration.md)
for explicit correction candidates, credentials, bounds and source saving.

The recorder needs `parecord` and `pactl` (`pulseaudio-utils` on Debian-family
systems) and an existing Pulse/PipeWire-Pulse connection. The default recording
source must be an available, unmuted microphone—not a playback monitor.

## Dictate

1. Press **F8** or run **`/oaistt`** to start. Wait for **`● REC`** before speaking.
2. Speak, then use the same control to stop. Wait for transcription/correction.
3. Text is appended to your latest editor draft; you can keep typing while it
   works. The existing draft is not corrected or replaced.
4. Review the result and send it yourself. Dictation never sends or queues a prompt.

**`/oaistt cancel`** discards unfinished dictation. Pi's Escape remains its own
agent-abort control. Submitting a prompt or requesting session/branch navigation
before delivery also discards the unfinished result—even if navigation is later
vetoed. Recording can run while the main agent is busy; processing toggles report
phase instead of starting another operation.

Phase appears in a named footer status and a short widget above the editor, so a
replacement footer need not hide recording feedback. Reload/shutdown clears both.

## Where your words go

The transcription server receives **audio**. Each attempted correction model in
your explicit ordered list receives **the transcript and bounded conversation
context**. Those providers may differ from Pi's main provider. There is no implicit
fallback to Pi's current model or an unlisted provider. Correction is enabled by
default, but the default candidate list is empty: raw text is inserted with one
muted notice. Explicitly disabling correction suppresses that notice and request.

For local-only use, choose a local transcription endpoint and only local correction
models. Set `correction.context.maxChars` to `0` to omit conversation history.
Direct tool results, images, thinking, shell output and custom messages are
excluded, but ordinary text and summaries may still describe sensitive information.
Exclusion is not redaction. Model correction can be wrong: review before sending.

The extension keeps no audio/transcript/credential logs or pending-result archive.
Temporary audio is deleted after completion or cancellation. Forced-stop artifacts
are never uploaded. Cancellation cannot recall sent data; receiving providers'
retention policies still apply. Uncatchable termination/host crashes can prevent
best-effort temporary-file cleanup.

**Containers:** supply host-approved audio access yourself. A Pulse/PipeWire-Pulse
socket can grant broad host audio access **and control**, not microphone-only
permission. A read-only filesystem bind does not make that protocol read-only.
The extension never mounts sockets, starts host services or changes host audio
defaults, mute or volume. Local server access does not grant microphone access.

## Development and evidence

Use Node **22.19+**:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests currently run on Node **26.10.0** with pinned Pi **0.99.2** fixtures. Pi modules
are host-provided peers, not bundled runtime dependencies. The package remains
private; no npm publication or v1 release is implied.

[DEVELOPMENT.md](DEVELOPMENT.md) separates automated/API evidence from live checks
and remaining acceptance work. A playback-monitor/local Whisper check succeeded;
that is **not microphone validation**.
