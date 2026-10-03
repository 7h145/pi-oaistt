# Configuration reference

v0.2.0 uses a **breaking order/maps schema**. Settings live in `pi-oaistt.json`
under public Pi `getAgentDir()`, with no project layer. Files must be regular,
non-symlink, at most 64 KiB. Reading defaults never writes a file.

Unknown/obsolete fields, invalid identities/order references and invalid tuning
fail closed. No malformed present transcription section inherits a shipped route.
Thinking faults remain isolated correction errors; malformed/conflicting keys
localize to those bindings. Other valid controls remain available.

## Example

Endpoints/model IDs below are placeholders, not compatibility evidence:

```json
{
  "recorder": { "source": null },
  "transcription": {
    "order": ["local", "remote"],
    "profiles": {
      "local": {
        "endpoint": "http://127.0.0.1:9000/v1/audio/transcriptions",
        "model": "YOUR_LOCAL_STT_MODEL",
        "auth": { "type": "none" },
        "language": null
      },
      "remote": {
        "endpoint": "https://stt.example.invalid/v1/audio/transcriptions",
        "model": "YOUR_REMOTE_STT_MODEL",
        "auth": { "type": "env", "name": "STT_API_KEY" }
      },
      "standby": {
        "endpoint": "https://standby.example.invalid/v1/audio/transcriptions",
        "model": "YOUR_STANDBY_MODEL",
        "auth": { "type": "env", "name": "STANDBY_STT_KEY" }
      }
    },
    "defaults": { "language": "en", "attemptTimeoutSeconds": 60 },
    "automaticFallback": false,
    "totalTimeoutSeconds": 120
  },
  "correction": {
    "enabled": true,
    "order": ["$current", "YOUR_PROVIDER/YOUR_MODEL"],
    "modelSettings": {
      "YOUR_PROVIDER/YOUR_MODEL": { "thinkingLevel": "low" },
      "ANOTHER_PROVIDER/MAIN_MODEL": { "thinkingLevel": null }
    },
    "defaults": { "thinkingLevel": null, "attemptTimeoutSeconds": 15 },
    "context": { "maxChars": 8000 },
    "totalTimeoutSeconds": 30
  },
  "delivery": { "dictationMarker": false },
  "keybindings": {
    "dictation.toggle": "f8",
    "editor.correct": "f7",
    "operation.cancel": "f12"
  }
}
```

## Defaults and bounds

Tuning resolves **named entry → section defaults → built-in**. Only absence
inherits; supported null clears. STT identity/auth never inherit. Preserve false
and zero where supported, not truthiness defaults.

| Field | Built-in / validation |
| --- | --- |
| `recorder.backend` | `parecord` only |
| `recorder.source` | null; named per-command override, at most 512 characters |
| `recorder.maxDurationSeconds` | 300; integer 1–1800 |
| `recorder.maxBytes` | 25165824; integer 1024–25165824 (24 MiB) |
| `recorder.stopTimeoutSeconds` | 3; integer 1–15 |
| `transcription.order` | built-in `['openai']` only when section absent; explicit order nonempty/unique, all names defined |
| `transcription.profiles` | at most 32; names 1–64 ASCII letters/digits/underscore/dot/hyphen, starting with letter/digit |
| Profile `endpoint`, `model`, `auth` | required explicitly, including inactive definitions |
| `transcription.defaults.language` | null; omit language; otherwise 2–3-letter code with optional subtags |
| `transcription.defaults.attemptTimeoutSeconds` | 60; profile override permitted |
| `transcription.automaticFallback` | false |
| `transcription.totalTimeoutSeconds` | 120; whole chain including preparation, not recording |
| `correction.enabled` | true; automatic only, not explicit F7 |
| `correction.order` | empty; at most 32 `provider/modelId` or `$current` selectors; model ID may contain slashes |
| `correction.modelSettings` | at most 32 actual named-model tuning entries; `$current` is not a key |
| `correction.defaults.thinkingLevel` | null; named override permitted |
| `correction.defaults.attemptTimeoutSeconds` | 15; named override permitted |
| `correction.totalTimeoutSeconds` | 30; includes snapshot/lookup/auth/request/response |
| `correction.context.maxChars` | 8000 Unicode code points; integer 0–100000, including labels/separators/markers |
| `delivery.dictationMarker` | false |

All request timeouts are finite positive numbers **≤3600 seconds**, including
fractional values. Attempt budgets are capped by the monotonic remaining total
budget. Zero disables history, not correction. Manual target and correction/STT
text limits are 64000 Unicode points; correction output is also capped at the
model's limit or 4096 tokens. Truncated/incomplete/tool-call results are rejected.
STT response bytes are capped at 256 KiB. Provider-body errors are never displayed.

Without a transcription section, the explicit `openai` definition is:
`https://api.openai.com/v1/audio/transcriptions`, `whisper-1`,
`auth: {"type":"env","name":"OPENAI_API_KEY"}`. An explicitly present section
must supply its own `order` and `profiles`, even if only changing tuning.

## Recorder and boxed setup

Provide `parecord`/`pactl` and an existing Pulse/PipeWire-Pulse connection. On Debian
family images, explicitly provision client tools with `pulseaudio-utils`; no host
daemon is needed. The extension never installs packages at startup.

Omitted/null source resolves the **server's current recording default at capture
start**, ignoring `PULSE_SOURCE` as a route override. A named override is passed as
argv, never a shell command or host-default mutation. Muted/missing/monitor defaults
fail; no alternate microphone is guessed. `recorder sources` is an explicit read-only
list of bounded source names and default/mute/monitor flags, not a properties dump.

Capture is private mono PCM16/16 kHz WAV. Readiness means audio bytes arrived, not
merely child spawn. Exact digital silence is rejected, not quiet speech by a volume
threshold. Per-stream latency/process requests are 100/20 ms, not universal capture
completeness guarantees. Duration cap requests graceful stop if ready; premature cap,
size overflow or failed/forced finalization discards. Graceful SIGINT timeout escalates
only the owned detached group through TERM (500 ms) and KILL/reap (1000 ms).

A boxed host must explicitly approve audio access and handle server authorization,
UID/cookie/path permissions. An illustrative host-approved bind uses your runtime's
bind-mount option for `APPROVED_PULSE_SOCKET` at `/run/host-pulse/native` and
`PULSE_SERVER=unix:/run/host-pulse/native`; provision client tools in the image.
This is not an exercised universal Docker/Podman/rootless recipe. Do not expose
another socket or change host defaults merely to make a test pass.

The socket can grant **broad host audio access/control**, including monitors,
playback and routing/volume changes under server policy. A `:ro` filesystem mount
does not make its protocol read-only. The extension does not mount sockets, start
host services or alter defaults/mute/volume. Networking to STT is a separate boundary.

## STT profiles, consent and preference

Only ordered names are selectable. Unlisted definitions are inactive; selecting or
saving them cannot activate them. Each profile needs a full HTTP(S) transcription
endpoint (no userinfo/query/fragment), model and explicit auth:

- `{"type":"none"}`: deliberately omit Authorization.
- `{"type":"env","name":"STT_API_KEY"}`: resolve that reference per attempt.

No literal secrets, credential commands, chat-provider auth or guessed env fallback.
Missing credentials are eligible profile failure, not a pre-capture singleton guard.
Use HTTPS except for explicitly trusted local services; HTTP protects neither audio
nor credentials. Redirects are refused. Only nonempty JSON object `text` is supported;
filename metadata is always `dictation.wav`, never the private path.

Fallback off means one selected profile. Turning it on **authorizes sending the same
validated WAV to following active profiles** sequentially, once, with no wrap or
parallel requests. Connection/auth/model/timeout/response failures can advance;
shared config, recording/audio failure, cancellation and total expiry cannot.
Warnings use fixed safe reasons, never response bodies.

Owned success becomes process-sticky before correction and survives conversation
changes. A newer choice/reselection/save/settings reload wins over held success.
Later correction cancellation does not undo an already legitimate preference.
Explicit save promotes an active name to the front, preserving other relative
order and inactive definitions. Automatic fallback never writes configuration.

Tools `oaistt_profiles` and `oaistt_select_profile(name, save?)` share command helpers.
Selection requires explicit user intent under normal Pi/harness permissions; no extra
extension dialog. Save defaults false. Tools expose bounded names/model labels/policy,
not endpoints/auth/drafts/audio; they cannot record, upload, correct, submit or change
host state. Permission annotations are hints for the harness, not an authorization
sandbox. Metadata may initialize lazily in non-TUI modes without audio/editor access.

## Correction, thinking and privacy

Resolve only ordered selectors, restart at the beginning each operation, and dedupe
actual registered provider/model identities at first position. `$current` freezes the
main identity at recording start/F7 invocation, **not its thinking level**. Named
settings outside order may tune that identity but never add requests. Pi owns actual
provider routing/auth; registered identity dedupe cannot identify all physical routers.

Thinking null/omission means **no override**, not guaranteed thinking off or absence
of native controls. Explicit off validates Pi-supported off, then omits `reasoning`
through Pi's normal adapter path. Other explicit levels (`minimal`, `low`, `medium`,
`high`, `xhigh`, `max`) must be supported by Pi's public helper/maps before SDK clamping.
Null inside Pi's thinking map means unsupported; it is not config-null inheritance.
Local unknown/unsupported/type-invalid thinking stops correction with a red error:
guarded raw dictation or manual unchanged, no next request or exhaustion notice.
Unused later models cannot reject earlier success. Ordinary provider rejection still
permits failover. Fix your extension policy or user-managed `models.json`; the
extension does not mutate model metadata, headers, auth or main-agent thinking.

One committed compaction/context-edit-aware active-branch snapshot includes user/
assistant text and eligible summaries, not direct tools, images, thinking, shell,
custom messages or metadata. Dictation target is only STT text, not existing editor
context. F7 explicitly targets the whole **unsent draft**, never attachment file
contents. Providers receive target plus bounded history; `maxChars: 0` removes history.
Text/summaries/drafts may contain sensitive information: exclusion is not redaction.

Normal exhaustion gives raw dictation plus a muted notice, or manual unchanged.
Cancellation delivers nothing and never restores the original draft. Requests are
isolated, no-tools, minimal-edit and fallible. Review before submission; cancellation
cannot recall transmitted data or guarantee receiving-provider deletion.

The optional marker is exactly `this is dictated\n\n`, only on a truly empty latest
semantic draft during delivery, in the same undo transaction as speech. Whitespace,
references or unknown content skip it. It never enters correction input, never comes
from manual F7, and is not tracked or rewritten after insertion.

## Commands

Bare `/oaistt` shows concise help/status. `/oaistt help` lists commands and
exact aliases, default/active controls, pending bindings and safe usage.
`/oaistt status` reports the operation and next recorder/profile selection.
Each response is one UI-only notification so Pi's consecutive-info coalescing
cannot hide help or pending-key details. Only these long forms/exact aliases
are supported:

| After `/oaistt` | Alias |
| --- | --- |
| `help` / `status` | `h` / `s` |
| `dictation toggle` | `d t` |
| `dictation start` / `dictation stop` | `d start` / `d stop` |
| `cancel` | `x` |
| `recorder sources` | `r l` |
| `recorder source NAME [--save]` | `r s NAME [--save]` |
| `transcription list` | `t l` |
| `transcription source NAME [--save]` | `t s NAME [--save]` |
| `reload` | `rl` |

No-name source reports current selection/usage, never a dialog or mutation.
`recorder source default [--save]` follows server default, persisting null.
There is no save-current-without-name, flat legacy source verb or typed correction.
Commands never submit a main-agent turn; output is UI-only.

Saves serialize the entire read/validate/modify/private atomic-rename transaction
through Pi's file mutation queue. Other fields/definitions are preserved; live edits
are checked before replacement. This is not a cross-process filesystem lock.
Settings-only reload resets next profile, preserves temporary recorder override and
active frozen work; a failed reload inhibits new work until fixed. Full reload resets
runtime preferences to file defaults and cancels old work. Temporary source/profile
changes never silently become saved defaults.

## Keys and reload

Action IDs: `dictation.toggle` (F8), `editor.correct` (F7), `operation.cancel` (F12),
plus unbound `dictation.start`/`dictation.stop`. Each value is one Pi key string or
an array; omission keeps defaults, `[]` disables. Modifiers: ctrl/alt/shift/super;
keys include Pi's letters, digits, special/symbol keys and F1–F12. Examples:
`"ctrl+shift+x"`, `["f8","f9"]`. Terminal support/interception still needs testing.

Canonical alias/modifier-order duplicates are disabled, not arbitrarily assigned.
Invalid actions/keys get localized red errors; no silent replacement by defaults.
Exposed native bindings are checked conservatively (including dialog controls).
Pi's own warning/later-registration priority handles other extensions; universal
shortcut enumeration/unregistration is not publicly available.

Key changes require **full Pi `/reload`**. `/oaistt reload` applies pipeline settings
and reports pending mappings but keeps active native handlers. Commands recover
configuration/dictation/cancellation independently; F7's buffer path has no naive
typed-command equivalent. Full reload also reloads current native keybindings before
checking conflicts; no raw-key takeover is installed.

## Migrate from v0.1.0

Back up and review your private file yourself, or explicitly ask an agent to migrate
it. Implementation/upgrading is not permission to edit private settings automatically.

1. Move old singleton transcription endpoint/model into a named profile and reference
   it in `transcription.order`. Convert `apiKeyEnv` to explicit env auth, or old null to
   `{"type":"none"}`. Do not copy placeholder endpoints blindly.
2. Move `language` and old `timeoutSeconds` to section defaults/profile tuning using
   `attemptTimeoutSeconds`; set a separate whole-chain timeout if desired.
3. Move correction `models` to `order`. Move `attemptTimeoutSeconds` to `defaults`;
   put named overrides in `modelSettings`. Only add `$current` with intentional consent.
4. Review recorder intent: default/null now follows the server, **not PULSE_SOURCE**.
   Put an intentional device override in `recorder.source` if needed.
5. Keep automatic fallback/marker off unless deliberately opting in. Review default
   F7/F12 and any conflicts. Full `/reload` loads v0.2 code/keys; inspect help/status.

Legacy fields are errors, not compatibility fallbacks. TTS, broader pi-lazy parity,
glossary enrichment, direct streams and `/lazy` compatibility remain out of scope.
