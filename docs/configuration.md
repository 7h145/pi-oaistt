# Configuration reference

Settings live in `pi-oaistt.json` under Pi's agent directory (`getAgentDir()`),
with no project layer. Files must be regular, non-symlink, at most 64 KiB.
Reading defaults never writes a file.

Unknown fields, invalid identities/order references and invalid tuning
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
    "automatic": true,
    "order": ["$current", "YOUR_PROVIDER/YOUR_MODEL"],
    "modelSettings": {
      "YOUR_PROVIDER/YOUR_MODEL": { "thinkingLevel": "low", "temperature": 0.2 },
      "ANOTHER_PROVIDER/MAIN_MODEL": { "thinkingLevel": null, "temperature": null }
    },
    "defaults": { "thinkingLevel": null, "temperature": null, "attemptTimeoutSeconds": 15 },
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
| `correction.automatic` | true; automatic post-STT attempts only, never model authorization; F7 independent |
| `correction.order` | `[]`; no candidates/requests by default; at most 32 `provider/modelId` or `$current` selectors; model ID may contain slashes |
| `correction.modelSettings` | at most 32 actual named-model tuning entries; `$current` is not a key |
| `correction.defaults.thinkingLevel` | null; named override permitted |
| `correction.defaults.temperature` | null; otherwise a finite nonnegative number; named override permitted |
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

Temperature inherits from `correction.defaults` when omitted in a named entry.
Explicit `null` clears inheritance and omits the request option, leaving Pi/the
adapter/backend default; `0` is an explicit override, not absence. There is no
forced temperature or API-specific exception. Named settings also apply to the
actual model resolved by `$current`, without authorizing extra candidates.

Numeric overrides are passed to Pi. Accepted ranges and sampling support depend
on the adapter/model; a syntactically valid number is not a compatibility promise.
For example, forcing a temperature can fail on the Codex route. Prefer null unless
you have verified an override. Rejected requests follow normal correction fallback;
the extension never silently substitutes another temperature.

Without a transcription section, the explicit `openai` definition is:
`https://api.openai.com/v1/audio/transcriptions`, `whisper-1`,
`auth: {"type":"env","name":"OPENAI_API_KEY"}`. An explicitly present section
must supply its own `order` and `profiles`, even if only changing tuning.

## Recorder and container audio

Provide `parecord`/`pactl` and an existing Pulse/PipeWire-Pulse connection. On Debian
family images, explicitly provision client tools with `pulseaudio-utils`; no host
daemon is needed. The extension never installs packages.

Recording checks both tools before querying sources or creating capture files.
Missing executables are reported by name, for example:
`Missing audio tools: pactl, parecord (package: pulseaudio-utils)`.
Server-access failures are separate; source listing requires only `pactl`.

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

In a containerized (or “boxed”) setup, Pi runs inside a container; see
[piinabox](https://github.com/7h145/piinabox). The host must explicitly approve
audio access and handle server authorization and UID/cookie/path permissions.
An illustrative host-approved bind uses your runtime's
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

`automatic: true` attempts post-STT correction only through the explicitly
configured order. Empty order means no requests and raw dictation under the
ordinary exhaustion/notice policy. `automatic: false` gives raw dictation without
a correction-failure notice. F7 shares the same selection and fallback order
regardless of this flag.
Actual correction needs a registered candidate, available Pi credentials and a
successful request; the flag alone cannot authorize a model.

The workflow selects a prompt composed of shared wording/context/safety rules and
mode-specific formatting rules; there is no separate mode setting. F7 asks to
preserve user paragraph breaks, indentation, wrapping, lists, Markdown/code
structure and outer whitespace. Post-STT correction asks to repair recognition
errors, punctuation, sentence breaks and accidental whitespace/layout, inferring
paragraphs/lists only when clear. Unclear structure defaults to one plain-prose
paragraph; clear paragraphs use blank lines and lists use simple bullets or
meaningful numbering, without fixed-column wrapping or invented content. Clearly
intended spoken formatting cues may become formatting, but quoted/discussed cues
stay content and other requests are never executed. Literal paths and attachment
references are protected in both prompts. These are model instructions, not a
promise of formatting accuracy; validate the chosen model in both workflows.

The [README correction example](../README.md#correction) is opt-in configuration
only. Its models are never shipped candidates, hidden fallbacks or automatically
appended entries. Neither credentials, a subscription nor the Whisper default
grant correction consent. Registration, auth and capabilities still use normal
request-time checks; no live compatibility or quality validation is claimed.

Resolve only ordered selectors. Start at the selected entry, then try only
following entries without wrapping. Deduplicate actual registered provider/model
identities at their first eligible position. A successful, still-owned response
remembers its selector for both F7 and dictation, without writing configuration.
Failure, exhaustion, cancellation and late results do not change that choice.
A newer manual choice/reselection/save or settings reload wins over held success;
later cancellation does not undo a choice legitimately remembered before it.

Initially select the first entry. `correction model SELECTOR` temporarily chooses
an entry already in `correction.order`; `--save` moves it to the saved first
position, preserving other relative order and unrelated settings. Neither tuning
entries outside the order nor available credentials authorize new candidates.
List/selection commands do not read drafts, resolve the main model, inspect
credentials or contact providers. Saving `$current` keeps the literal selector.

An eligible `$current` freezes the main identity at recording start/F7 invocation,
**not its thinking level**. Pi's main-model changes do not select another entry;
the next operation resolves `$current` afresh if it is eligible. Named settings
outside order may tune that identity but never add requests. Pi owns actual
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

Bare `/oaistt` and `/oaistt status` show identical full status, with a help hint.
`/oaistt help` shows commands, exact aliases, default/active controls and safe usage,
without appended status. Request status separately for pending bindings.

The single-line startup tagline uses active shortcuts after binding-conflict checks,
with a `dim` base, bold `text`-colored highlights and `·` separators; Pi handles wrapping. A bound toggle
shows “to dictate”; without it, both start and stop must be bound to show their
hints. An incomplete pair omits dictation. Unbound correction/cancel hints are
omitted independently. `see /oaistt help` always remains. This is orientation,
not a microphone/provider readiness check.

Progress uses one owner-scoped widget above the editor. oaistt neither writes
footer statuses nor replaces the footer. During recording, the widget shows
`● REC 00:05 · oaistt · F8 stop · F12 cancel` with active, conflict-filtered
bindings. Only the REC indicator/timer is red; separators/words are muted and
brand/keys use bold `text`. Toggle takes precedence, otherwise use an explicit
stop key; unlike startup, no start/stop pair is required once recording is active.
Start/correction keys are never shown here. Cancellation is independent. Unbound
hints are omitted; all-unbound recording retains `● REC 00:05 · oaistt`, with
slash commands still available. Pending configuration never changes the advertised
active keys before full reload. Pi owns narrow-terminal wrapping/clipping; the
existing elapsed/theme refresh and ownership-scoped clearing are unchanged.

Transcription and both automatic/manual correction show
`oaistt · transcribing… · F12 cancel` or `oaistt · correcting… · F12 cancel`.
These lines use the same muted words/separators and bold `text` brand/keys, with
no red indicator or stop hint. Cancel uses active, conflict-filtered bindings;
unbound/conflicting keys are omitted, and pending keys wait for full Pi `/reload`.
Cancellation prevents dictation insertion or leaves the manual draft unchanged;
it never aborts the main agent. The widget refreshes with the theme and clears
when processing or ownership ends.

The status header identifies the loaded installation, for example
`oaistt v0.2.2 (1234abc): idle. Configuration loaded successfully.` Version comes
from its own `package.json`, not the latest tag. The seven-character hash is its checkout HEAD,
not a guarantee of an unchanged working tree. Git is optional: npm/non-Git installs
show the version alone. Only Git metadata at the resolved package root is used;
the working project, Pi repository and parent repositories are never searched.
Identity is cached once per interactive extension runtime, so status calls do not
spawn Git. Missing/malformed metadata cannot block dictation; unavailable version
metadata leaves the plain `oaistt` header. No paths or Git diagnostics are displayed.

Status uses muted body text and bold `text` headings/keys, ordered as
Transcription, Correction, Capture device, and Active keys. Profile/model orders
and human-readable key mappings are bullet lists; only each order's first candidate
is bold, with no bracket/selection marker. Unbound controls remain visible but muted.
Pending bindings add a matching list and full-reload guidance.

Transcription shows the owned operation's profile, saved default and `Fallback`
switch. Its ordered list previews the effective chain for the next dictation:
start at the selected profile, then only following profiles if fallback is on,
without wrapping; otherwise show only the selected profile. Automatic success can
change this process-local starting point without changing the saved default.
Correction shows automatic mode, the selected entry, saved default and following
candidates for the next operation. `$current` includes the main identity at display
time only when eligible in that chain.
Neither status list is a live-attempt/availability claim. Status probes no models, audio
or credentials. `Configuration loaded successfully` means parsed configuration is
available, not provider/microphone/shortcut readiness. Failed loading reports
`Configuration unavailable`, with a separate diagnostic; a missing file uses defaults.
Capture device shows the selected PA source name, or `server default source`.
During owned dictation it shows that operation's frozen source selection, not a
newly changed setting; otherwise it shows the current selection. Names are
control-stripped and length-bounded, without querying audio or dumping device
properties. The default label describes server-default selection, not a probe of
the resolved physical device. Active work retains its frozen settings and model
identity even when selections change.

Full help introduces dictation/draft correction, then presents active controls,
dictation commands, transcription profiles, correction models, capture device,
settings/help, and notes. Abbreviation notation is explained after controls,
before the commands;
notes explain temporary selections and `--save` once. Headings, commands and keys
use bold `text` highlights over a muted base, without boxes or section colors.
Controls include differing defaults and any bound start/stop keys. The compact
correction line names the selected model (resolving `$current` when selected),
or explains missing configuration. It is not an availability check;
standalone status retains the complete next-operation order and pending keys.

The two selection-list commands serve a different purpose from status: they
show exact arguments accepted by the selection commands, in saved order, including
choices before the selected entry. They do not repeat defaults, switches or next
attempts. `transcription list` (or `t l`) labels its columns `NAME` and `MODEL`;
pass only `NAME` to `transcription profile NAME`. `correction list` labels its
single column `SELECTOR`; pass the whole identifier to `correction model SELECTOR`.
Names/selectors are not shortened; secondary STT model labels remain bounded.
The selected argument is bold, and a concrete command example explains selection
and optional `--save`. Only ordered, selectable entries are shown; inactive
definitions/tuning are omitted. `$current` stays literal, with no identity or
availability lookup. Empty correction order and unavailable settings are explained
without inventing choices. Agent-facing metadata tools still return structured JSON.

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
| `transcription profile NAME [--save]` | `t p NAME [--save]` |
| `correction list` | `c l` |
| `correction model SELECTOR [--save]` | `c m SELECTOR [--save]` |
| `reload` | `rl` |

No-name `recorder source` / `transcription profile`, and no-selector
`correction model`, report current selection/usage, never a dialog or mutation.
`recorder source default [--save]` follows server default, persisting null.
Only the commands and aliases listed above are accepted. Saving a selection
requires a name or model selector; draft correction is invoked with F7, not a
typed command.
Commands never submit a main-agent turn; output is UI-only.

Saves serialize the entire read/validate/modify/private atomic-rename transaction
through Pi's file mutation queue. Other fields/definitions are preserved; live edits
are checked before replacement. This is not a cross-process filesystem lock.
Settings-only reload resets next profile and correction model to their saved first
entries, preserving temporary recorder override and active frozen work; a failed
reload inhibits new work until fixed. Full reload resets runtime preferences to
file defaults and cancels old work. Temporary source/profile/model changes never
silently become saved defaults.

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

### Editor replacement

When Pi installs or replaces pi-oaistt's editor, including during full
`/reload`, draft text is transferred in expanded form. Collapsed pasted blocks
may become fully visible; their text is preserved. Previous undo history may
not carry over to the replacement editor.
