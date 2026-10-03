# pi-oaistt

Speak into Pi's draft, review, then send it yourself. Or correct an existing draft
without recording. Both work while the main agent is busy.

**v0.2.0 — development.** Tested API baseline: Pi **0.99.2**, Node **26.10.0**,
Linux interactive terminal mode. Automated native/synthetic checks are not live
microphone, keyboard or provider-quality acceptance. Other Pi versions, normal
Linux deployments and the wider boxed/provider matrix remain unverified.

## Load

Choose one method; do not load the extension twice:

- From the checkout: `pi --extension ./index.ts`.
- Or symlink this checkout into `.pi/extensions/pi-oaistt`, grant project trust,
  then run Pi's **`/reload`**.

Pi supplies the peer modules. A ready notice confirms loading, not microphone,
authentication or service health. Loading opens no microphone and makes no provider
request. The extension requires the stock editor and refuses unknown custom-editor
composition. RPC/print/JSON cannot dictate or correct an editor; the narrow profile
tools can load metadata lazily without acquiring microphone/editor capabilities.

**Upgrading from v0.1?** Read [migration](docs/configuration.md#migrate-from-v010)
first. The old singleton STT/correction schema is rejected, not silently rerouted or
automatically rewritten. Your private configuration must be migrated explicitly.

## Configure before use

Use **`pi-oaistt.json` in Pi's configured agent directory**, not a project file.
With no transcription section/file, the explicit built-in `openai` profile uses
OpenAI's transcription endpoint, `whisper-1`, and an `OPENAI_API_KEY` environment
reference. Automatic STT fallback is off; correction order is empty.

For an intentionally unauthenticated local compatible server, adjust port/model:

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
  },
  "correction": { "enabled": false }
}
```

Then **`/oaistt reload`** applies pipeline settings to subsequent operations,
resets the preferred profile, and lets active frozen work finish. Key/code changes
require **full Pi `/reload`**, which cancels old operations.

The recorder needs `pactl` and `parecord` (`pulseaudio-utils` on Debian-family
systems) plus existing Pulse/PipeWire-Pulse access. The recording server's default
must be an available, unmuted non-monitor source. The extension installs nothing
and changes no host defaults, mute or volume. See [setup and bounds](docs/configuration.md).

## Controls

| Default | Action |
| --- | --- |
| **F8** | Start recording; when recording, stop and use it |
| **F7** | Correct the current whole draft, without recorder/STT |
| **F12** | Cancel only oaistt |
| **`/oaistt`** | Read-only help/status, never start |

Keys are configurable; help shows active/pending mappings. Native cross-extension
shortcut conflicts follow Pi's own warning/priority policy, not universal conflict
detection. Escape remains Pi's main-agent control.

Dictation: wait for **`● REC`**, speak, press F8, then wait for transcription and
optional correction. You may keep typing; delivery appends to the latest draft,
not the cursor, without changing existing text. Review and submit manually.
Starting/processing/cleanup toggles report phase rather than restarting work.

Manual F7 correction replaces the still-owned unchanged draft directly, undoably.
Any actual typing/paste/attachment/programmatic edit cancels pending replacement,
even edit-and-revert. Cursor/focus alone does not. Failure leaves your latest draft
untouched; no restoration, preview or automatic submission. Identical output does
not create an undo entry. Explicit F7 works even with automatic correction disabled.
There is no typed draft-correction command or `/lazy` compatibility wrapper.

Both paths share one operation. Prompt capture, session/editor replacement, full
reload and explicit cancellation discard unfinished work. Recorder ownership stays
held through teardown. Status plus an above-editor widget show progress even when a
replacement footer omits extension statuses. Paste display may expand; semantic
text/references are preserved. Editor replacement/reload may change editor history.

Long commands and exact aliases are in the [configuration reference](docs/configuration.md#commands).

## Where your data goes

The selected STT profile receives **audio**. Only enabling `automaticFallback`
authorizes sequential upload to following active profiles; defining/listing them
does not. A successful route becomes process-sticky, never automatically saved.

Each attempted correction provider receives **the target and bounded committed
conversation history**. Manual F7 explicitly exposes the **unsent draft**. Providers
may differ from the main agent. `$current` is an explicit start-frozen selector,
never an implicit fallback; named tuning does not add candidates. For local-only
use, choose local endpoints/models; `context.maxChars: 0` omits history.

Direct tools, images, thinking, shell and custom messages are excluded from history,
but ordinary text/summaries/drafts may contain sensitive information. This is not
redaction or a semantic prompt-injection guarantee. Review corrections before sending.

Safe warning notices identify real failover transitions. Correction exhaustion
inserts raw dictation with a muted notice; local invalid thinking gets a red error
and guarded raw dictation. Manual failures never write. The optional
`delivery.dictationMarker` is off by default and only prefixes a truly empty latest
draft; it is not sent to the corrector or generated by F7.

No audio/transcript/credential logs or pending-result archive are kept. Private audio
is deleted on completion/cancellation; forced-stop artifacts are never uploaded.
Cancellation cannot recall transmitted data or guarantee provider deletion. Crashes
can prevent best-effort cleanup. Avoid raw provider/terminal tracing during validation.

**Containers:** host-approved socket access can grant **broad host audio access and
control**, not microphone-only permission. A read-only filesystem bind does not make
that protocol read-only. The extension mounts no sockets or starts host services.
Server networking is separate from microphone access.

## Development and acceptance

From a checkout, using Node 22.19+:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Dependencies are pinned for development; Pi peers are not bundled runtimes. The
package remains private; no publication/release is implied. [Engineering evidence](DEVELOPMENT.md)
separates current automated checks from historical v0.1 live observations. The
[v0.2 live checklist](docs/validation.md) remains owner/tester-assisted work.

## License and attribution

[MIT](LICENSE). Copyright (c) 2026 thias <github.attic@typedef.net>.
Source headers credit thias and OpenAI Codex (gpt-6.1-sol), using the owner's
requested attribution style. Official Git attribution belongs to thias.
