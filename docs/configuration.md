# Configuration schema (implementation baseline)

The config layer reads `pi-oaistt.json` in Pi's configured agent directory.
The eventual extension entry point supplies Pi's `getAgentDir()` value; do not
add a project-level config or hard-code a home path. Command/recorder/provider
integration is still in progress; the following schema is implemented and tested.

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
budget 1–15 seconds. Overlong recording/forced-stop policy will be documented
with the actual recorder adapter. No recorder is currently exposed by the package.

## Transcription

Use a full HTTP(S) transcription URL, not a chat base URL. Embedded URL
credentials, query parameters and fragments are rejected. Use HTTPS except for
trusted local-network/loopback services; HTTP does not protect audio or credentials.

Only an environment-variable **reference** is allowed for transcription auth.
The configured variable must exist and be nonempty; missing auth does not select
a different variable/provider. No literal key, shell command, implicit Pi chat
credential or OAuth substitution. `apiKeyEnv: null` means no Authorization header,
for an intentionally unauthenticated compatible local service. Request timeout:
1–600 seconds. Provider errors must not echo response bodies or credentials.

`language: null` leaves language unspecified; a supplied language is a 2–3-letter
code with optional subtags. `model` is a nonempty explicit string. Actual local
and remote multipart compatibility still needs integration validation.

## Correction and provider boundaries

Correction uses only the ordered `provider/modelId` list (max 32 entries). A model
ID may contain further slashes. There is no `$current`, session-model or hidden
fallback. With correction enabled and no usable candidates, the policy is raw
transcription plus one muted notice. `enabled: false` suppresses correction and
that failure notice. Attempt budget: 1–120 seconds; total: 1–300 seconds.

`context.maxChars` counts **Unicode code points**, including labels/separators,
not UTF-16 code units. Bounds: 0–100000; 0 disables conversation context, not
correction. The correction implementation will use committed compaction-aware
user/assistant text and summaries, not tools, images, thinking, shell or editor
content. Ordinary text/summaries may still describe sensitive file/tool content;
exclusions are not redaction.

Audio goes to the transcription endpoint. **Every attempted correction provider**
receives the transcript and bounded context. Those destinations may differ from
the main-agent provider. Explicit remote candidates permit those destinations.
For local-only use, set a local STT URL/auth policy and list only locally configured
Pi models; use `context.maxChars: 0` to omit conversation history. Cancellation
cannot recall information already sent to a provider; provider retention policies
still apply. No per-turn privacy warning is planned.

## Source overrides and persistence

The config store supports a temporary source override (`null` restores default
routing). Loading/switching the override does not write anything. Only explicit
source-save writes `pi-oaistt.json`, preserving other live on-disk settings.
Writes use a private temporary file and atomic rename, detect intervening config
edits, reject invalid/symlinked targets and remove temporary files. Command syntax
and user-facing controls will be documented when the entry point is implemented.

Every operation receives an independent, deeply frozen effective-config snapshot;
later source/config changes cannot reroute it. No examples contain credentials.
