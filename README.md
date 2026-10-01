# pi-oaistt

Speak a draft into Pi, then review it before sending.

**Under development:** this repository is not yet an installable dictation
extension. The controls below describe the intended workflow; they are not wired
into Pi yet.

## Intended workflow

1. Press **F8** or run **`/oaistt`** to start recording.
2. Speak, then use the same control to stop.
3. The extension transcribes your recording, optionally corrects the text, and
   appends it to your latest editor draft. You can keep typing while it works.
4. Review the draft and send it yourself. Dictation never sends or queues a prompt.

Use **`/oaistt cancel`** to discard dictation, not Pi's Escape key. Submitting a
prompt or changing sessions before dictation finishes also discards the unfinished
result. Dictation owns its cancellation; it must not stop Pi's main agent.

The target is Linux Pi's interactive terminal, including dictation while the main
agent is busy. Microphone access and transcription-server access are separate:
a local server does not give a container access to your microphone.

## Where your words go

The configured transcription server receives **audio**. If correction is enabled,
each attempted model in your ordered correction list receives **the transcript and
bounded conversation context**. Those providers may differ from Pi's main provider.
There is no implicit fallback to Pi's current model or an unlisted provider.

For local-only use, choose a local transcription endpoint and only local correction
models. Set `correction.context.maxChars` to `0` to omit conversation history.
Direct tool results, images, thinking and shell output are excluded from the planned
context filter, but ordinary conversation text and summaries may still describe
sensitive information. Exclusion is not redaction.

The extension keeps no audio/transcript logs or pending-result archive. Temporary
audio is deleted after completion or cancellation. Cancellation cannot recall data
already sent; the receiving provider's retention policy still applies.

**Containers:** supply host-approved audio access yourself. A Pulse/PipeWire-Pulse
socket can grant broad host audio access **and control**, not microphone-only
permission. A read-only filesystem bind does not make that protocol read-only.
The extension will not mount sockets, start host services or change host audio
defaults, mute or volume. The supported recorder needs `parecord` and `pactl`
(`pulseaudio-utils` on Debian-family systems).

See the [configuration reference](docs/configuration.md) for settings and limits.

## Current status and development

Editor delivery, configuration, operation control, recorder cleanup and compatible
transcription have automated tests. A live playback-monitor/local Whisper check
also succeeded; that is **not microphone validation**. Correction and Pi
command/lifecycle integration remain in progress. [DEVELOPMENT.md](DEVELOPMENT.md)
records evidence and the remaining acceptance checks.

To work on the implementation, use Node **22.19+** and run:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Current tests use Pi **0.99.2** and Node **26.10.0**. Pi packages are development
fixtures and host-provided peers, not bundled runtime dependencies. The package
remains private and has no extension entry point until the pipeline is integrated.
