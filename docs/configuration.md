# Configuration reference

**v0.1.0 is a development build for initial validation.** See the
[README](../README.md) for loading and first use. Command/lifecycle integration is
implemented; real microphone and provider/terminal acceptance are still pending.

Settings belong in `pi-oaistt.json` under Pi's configured agent directory. There is
no project-level config layer. Reading defaults does not create a file; changing
an in-session source will stay temporary unless you explicitly save it.

Missing files/fields use these defaults. Invalid JSON, unknown fields, wrong
types and out-of-range values fail closed; invalid endpoints/models never fall
back to another provider. Config must be a regular, non-symlink file <=64 KiB.

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
    "endpoint": "https://api.openai.com/v1/audio/transcriptions",
    "model": "whisper-1",
    "language": null,
    "apiKeyEnv": "OPENAI_API_KEY",
    "timeoutSeconds": 60
  },
  "correction": {
    "enabled": true,
    "models": [],
    "context": { "maxChars": 8000 },
    "attemptTimeoutSeconds": 15,
    "totalTimeoutSeconds": 30
  }
}
```

## Recorder

The first targeted backend is `parecord` (PulseAudio / PipeWire-Pulse), not an
untested auto-probing chain. `pulseaudio-utils` supplies `parecord` and `pactl` on
Debian-family systems; provisioning/capture validation remain separate work.
`source: null` follows the recording source at capture start. A named source
is passed only to the recorder, never set as the host default.

Bounds: duration 1–1800 seconds; file bytes 1024–25165824 (24 MiB); graceful-stop
budget 1–15 seconds. At the duration cap, request ordinary graceful stop and
transcription. If the cap arrives before readiness, discard instead. Exceeding the
size cap, a forced-stop timeout or failed WAV finalization always discards; forced
termination never silently uploads even a parseable file. Final PCM duration must
also fit duration plus stop budget. Private files/directories are removed after
completion/cancellation. Capture defaults to mono PCM16/16 kHz WAV. Reject exact
digital silence, not quiet speech by a volume threshold.

The recorder requests 100 ms latency and 20 ms processing per stream to reduce
buffered-audio loss on stop. These are requests, not guarantees for every device or
server, and do not change host defaults or volume. Recording readiness requires
audio bytes to reach the file, not merely a spawned process. Real microphone tests
still need to check the first and last words; see [test evidence](../DEVELOPMENT.md).
Muted/missing sources and playback monitors fail preflight. A monitor is not a mic;
owner-authorized monitor experiments are separate diagnostics, not a production
fallback. `PULSE_SOURCE`, when set, is an explicit routing override; otherwise the
host default is resolved at each capture, never pinned at container startup.

Boxed setups must already have host-approved audio access and container recorder
tools. Exposing a Pulse/PipeWire-Pulse socket can grant **broad host audio access
and control**, not microphone-only permission; a read-only filesystem bind does
not make its protocol read-only. This extension does not mount sockets, start host
services or alter routing/default/mute/volume state. F8 and `/oaistt` start/stop
only the operation-owned recorder; `/oaistt cancel` discards unfinished work.

## Transcription

Use a full HTTP(S) transcription URL, not a chat base URL. Embedded URL
credentials, query parameters and fragments are rejected. Use HTTPS except for
trusted local-network/loopback services; HTTP does not protect audio or credentials.

Only an environment-variable **reference** is allowed for transcription auth.
The configured variable must exist and be nonempty; missing auth does not select
a different variable/provider. No literal key, shell command, implicit Pi chat
credential or OAuth substitution. `apiKeyEnv: null` means no Authorization header,
for an intentionally unauthenticated compatible local service. Request timeout:
1–600 seconds. Provider errors do not echo response bodies or credentials.
Automatic HTTP redirects are refused to avoid sending audio to another URL. WAV
size/duration/PCM validation is repeated before upload. Responses are bounded to
256 KiB and 64000 transcript Unicode code points; only nonempty JSON `text` is
supported. Filename metadata is a fixed `dictation.wav`, never the private path.

`language: null` leaves language unspecified; a supplied language is a 2–3-letter
code with optional subtags. `model` is a nonempty explicit string. A synthetic loopback HTTP server and one live owner-provided local Whisper route
returned compatible multipart/JSON responses. Other local/remote services and
provider authentication still need integration validation.

## Correction and provider boundaries

Correction uses only the ordered `provider/modelId` list (max 32 entries). A model
ID may contain further slashes. There is no `$current`, session-model or hidden
fallback. With correction enabled and no usable candidates, the policy is raw
transcription plus one muted notice. `enabled: false` suppresses correction and
that failure notice. Attempt budget: 1–120 seconds; total: 1–300 seconds.

`context.maxChars` counts **Unicode code points**, including labels/separators,
not UTF-16 code units. Bounds: 0–100000; 0 disables conversation context, not
correction. Correction uses Pi's committed active-branch session projection,
respecting compaction, branch summaries and context-edit omissions. It retains
eligible user/assistant text and active summaries, not direct tool results,
images, thinking, shell, custom messages, metadata or editor content. Ordinary text/summaries may still describe sensitive file/tool content;
exclusions are not redaction.

Audio goes to the transcription endpoint. **Every attempted correction provider**
receives the transcript and bounded context. Those destinations may differ from
the main-agent provider. Explicit remote candidates permit those destinations.
For local-only use, set a local STT URL/auth policy and list only locally configured
Pi models; use `context.maxChars: 0` to omit conversation history. Cancellation
cannot recall information already sent to a provider; provider retention policies
still apply. There is no per-turn privacy warning.

Candidates resolve and stream through Pi's public model registry. Unknown models,
missing auth, errors, invalid/empty output and per-attempt timeouts advance through
only your list; total timeout/exhaustion uses raw text with one muted notice.
Cancellation never delivers either result. Requests are isolated from the agent:
no tools, main system prompt, selected-model fallback, chat turn or prompt queue.
Each candidate receives fresh request objects from the same initial text snapshot.
The model is instructed to make minimal corrections; JSON isolation is not a
semantic prompt-injection guarantee, and correction quality needs live testing.

## Source changes and saving

A source override is temporary; `null` restores default routing. Loading settings
or changing that override does not write a config file. Explicit source-save writes
only the source change and preserves other on-disk settings. Invalid settings or
an intervening file edit fail the save rather than overwriting them. Writes replace
the config atomically through a private temporary file.

Each dictation uses the settings it started with. Changing the source or config
cannot reroute an operation already in progress.

- `/oaistt source`: ask for a source name in a cancellable Pi input dialog.
- `/oaistt source <name>`: temporary named source.
- `/oaistt source default`: temporary return to env/default routing (`PULSE_SOURCE`
  remains an explicit environment override).
- Add `--save` to either explicit choice, or `/oaistt source --save` to save the
  current override. No save happens without that flag.
- `/oaistt reload`: re-read file settings, retaining temporary source overrides.
- `/oaistt status`: show phase and coarse configuration policy without echoing
  endpoint, source, credential or transcript values.

Source changes and settings reloads affect the next operation only. Invalid or
changed files fail closed; fix the file and explicitly reload rather than relying
on fallback defaults. A temporary override does not survive an extension-code
reload/new runtime unless saved. The UI does not enumerate or change host sources.
