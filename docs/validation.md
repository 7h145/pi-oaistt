# Live acceptance checklist

Automated/native synthetic tests do not establish microphone completeness, physical
keyboard delivery or provider quality. Validate the current build and chosen
setup; one successful route does not establish the whole acceptance matrix.

Use synthetic speech/text. Record only pass/fail, versions, broad deployment type,
phase and timing—no audio, transcripts, credentials, device identifiers or private
configuration. Do not enable raw provider/terminal tracing.

## Prepare deliberately

- Review settings against the [configuration reference](configuration.md),
  including the intended endpoint/model/auth and authorized data destinations.
  No file/transcription section means the built-in OpenAI profile.
- Load code/keys with full Pi `/reload`, then inspect `/oaistt` status and
  `/oaistt help` separately.
- Confirm `pactl`/`parecord`, host-approved audio access and available unmuted microphone.
  Do not alter host defaults/volume or expose a socket merely for testing. Monitors
  are not microphones.
- In a containerized (or “boxed”) setup, Pi runs inside a container; see
  [piinabox](https://github.com/7h145/piinabox). Arrange explicitly approved host
  audio access. A shared Pulse socket can grant broad audio access/control.
- Begin with auto-correction disabled, fallback/marker off. Enable providers/features
  only when you intend their data exposure. Set history budget 0 if desired.

## Audio, append and cleanup

1. F8, wait for REC, speak a synthetic phrase, F8, review the unsent result.
   Check first/last words and wall-clock/sample duration. Repeat.
2. Keep typing through capture/processing: append once to latest text, not cursor.
3. Include multiline/large paste plus synthetic image/path references. Undo restores
   pre-append semantic text; collapsed display may expand. Test clipboard behavior
   only with approved synthetic content, never real attachments for convenience.
4. F12 or `/oaistt cancel` during recording/processing: no late text or stale REC.
   Confirm teardown/restart without orphaned child/private recordings. Failures
   never upload forced-stop or invalid audio.

## F7 manual correction

- Configure an explicit approved model order; F7 works with automatic correction off
  and while the main agent is busy. No mic/STT/main-agent turn, submit or queue.
- Correct a synthetic draft with spacing, multiline paste and reference paths. Direct
  whole-draft replacement, single undo; identical output makes no undo entry.
- While pending, type, paste, set/undo/edit-and-revert or attach synthetic content:
  abort/discard, latest user draft retained, no restoration or raw insertion.
- Cursor/focus/dialog-only movement does not cancel. F7 in another focused dialog
  must not secretly correct the main draft. Empty/whitespace draft makes no request.
- F12, submit-and-retype, session/editor replacement and full reload invalidate;
  settings-only reload leaves the old frozen request intact. Failed new settings
  block future work without cancelling already authorized work.

## Busy, capture and lifecycle

Test regular submit/steer, follow-up and compaction queues before result delivery:
muted discard, no late edit to a new draft, and main work unaffected. Try session/
branch requests, including a veto if practical; returning cannot recover old work.
Escape remains the main-agent control, never oaistt cancellation.

Full Pi reload cancels old work and restores semantic draft state/registrations.
Editor instance/history may change; do not claim seamless cross-reload undo.

## Profiles, saves and provider boundaries

- `transcription list`/tool metadata expose names/model labels/policy, no endpoints,
  credentials, audio or draft. Unknown/inactive selection fails, without probing.
- Temporary selection affects only next operation. With fallback off, unreachable
  selected endpoint cannot upload to another profile.
- If deliberately enabling fallback, verify following-only/no-wrap behavior, visible
  safe warnings and sticky successful profile. Review remote upload consent first.
- Change/reselect/save/reload while success is held: newer choice wins. Conversation
  changes preserve preference; later correction cancellation does not erase an
  earlier legitimate STT success. Late cancelled STT cannot publish preference.
- Exercise `--save` only when intended. Inspect private saved order/source yourself:
  front promotion, other relative order/fields/inactive entries preserved, no auto-save.
- Recorder source with no name is read-only, not a dialog. Explicit `default` follows
  server default, not PULSE_SOURCE. Listing and overrides never mutate the host.

## Correction thinking and quality

Approve each ordered destination first. Test explicit `$current` plus literals,
main identity change while recording, alias dedupe and named tuning outside order.
No implicit/sticky correction model should appear.

Test `correction.automatic` true/false with empty, configured and unavailable orders:
empty order makes no requests even with credentials or a selected main model;
automatic false gives raw speech without a correction-failure notice; F7 remains
independent. The opt-in README recommendation must never appear without an explicit
order entry or be appended to an existing chain. Choosing it is not live validation;
test its registration/auth/capabilities and quality separately if you opt in.

Check temperature unset/null (no sampling override), an approved numeric default,
a named override including `0`, and named null clearing that default. `$current`
uses its actual model's tuning. Verify only explicitly authorized models/settings;
synthetic option tests do not establish adapter/backend acceptance. If a request
rejects an override, normal fallback must occur without silently changing its value.

Check null/unset/off and approved supported levels on selected actual providers;
verify mapped controls and quality using synthetic technical names, ambiguity and
multilingual text. Locally invalid thinking gives red error plus guarded raw
speech/manual unchanged, no next request or ordinary exhaustion notice. Supported
provider rejection permits normal failover. Never edit capability metadata silently
to make tests pass. Normal exhaustion is raw/unchanged; cancellation is no result.

## Marker, keys and feedback

- Marker disabled/enabled: only strict-empty latest draft qualifies, not whitespace,
  references, mixed/repeated input. It never enters correction input or comes from F7;
  later edits/removal and one undo behave normally.
- Default/rebound/disabled/multiple F7/F8/F12 keys, exact command aliases, native key
  conflicts and other-extension Pi-priority warnings. Settings-only key changes stay
  pending until full reload; commands remain recovery controls.
- During REC, check brand/stop/cancel hints: active toggle wins, otherwise active
  stop alone suffices; cancel is independent, start/correction are omitted.
  All-unbound recording shows only REC/timer/brand, not invented default keys.
  Only REC/timer is red; theme changes refresh the neutral guidance. Pending keys
  must not change these hints, and leaving recording/ownership must clear them.
- Check physical terminal/tmux interception, narrow regular/fullscreen layouts,
  theme changes and above-editor widget visibility. Stock/custom footers and other
  extensions' footer statuses must remain unchanged during work and cleanup.
  Feedback must not duplicate, outlive ownership or become context.

Record the matrix separately: normal Linux / owner-approved boxed; local / remote
compatible STT; each selected correction provider; physical terminal/tmux and busy/
compaction paths actually observed. Missing cells remain untested, not inferred from
synthetic HTTP/faux providers or one successful route.
