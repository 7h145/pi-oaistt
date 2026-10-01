# Live validation checklist

One owner-confirmed local dictation/draft/manual-submit check has passed.
The following checks remain broader acceptance work, not claims of universal
support. Use synthetic speech/text and record only pass/fail, environment versions
and timing—not audio, transcripts, credentials or private settings.

## Prepare

- Load the code with `/reload`; check `/oaistt status`.
- Confirm your actual transcription destination in your private config. Status
  reports coarse policy, not endpoint values. Missing config means OpenAI defaults.
- Keep correction disabled for initial audio/editor checks. Do not enable it until
  you explicitly choose and approve each correction candidate/destination.
- Have an available, unmuted microphone and installed `pactl`/`parecord` clients.
  Do not change host defaults merely for testing. Playback monitors are not mics.
- Do not enable raw terminal/provider tracing during these checks.

## Audio and draft

1. Start with F8, wait for `● REC`, speak a short synthetic phrase, stop with F8.
   Check beginning/end, appended text and review before manual submission.
2. Repeat in the same session. Keep typing during capture/processing; your latest
   draft must remain intact, followed by one appended result.
3. Try a multiline draft with a large pasted synthetic block and ordinary path
   references. One undo after append should restore the pre-append draft without
   dangling collapsed-paste markers. Do not upload real attachments just for a test.
4. Cancel while recording, then during processing if you can catch that phase.
   `/oaistt cancel` must leave no result, no REC label and no pending operation.

## Busy, submission and lifecycle

- While Pi is already working, start/stop dictation and continue typing. Main work
  must not be aborted or fed an automatic prompt. Check draft delivery while busy
  if the main operation lasts long enough.
- For a synthetic prompt you deliberately intend to submit to the main agent,
  submit before dictation delivery—while recording is an easy timing window.
  Expect one muted discard notice and no late text in the new draft. Try ordinary
  submit and follow-up/compaction paths when available; note which were observed.
- Request session/branch navigation before delivery. Expect discard, even if a
  later navigation step is vetoed. Returning must not recover the old result.
- Reload while capturing/processing: owned work must be discarded, feedback
  cleared, the draft preserved and a fresh operation possible after reload.
- Pi Escape remains the main-agent control, not dictation cancel. Use it only when
  you intend to abort main work. Escape inside the source dialog cancels that choice.

## Source and feedback

- `/oaistt source` opens a choice dialog. Cancel it; draft, source and active
  dictation must remain unchanged. Confirm a valid source only when you intend
  that temporary route; the extension never changes the host default.
- Source choices are temporary. Exercise `--save` only if you intend persistence;
  inspect your private config yourself. Settings reload cannot reroute active work.
- Check REC/timer and processing labels at narrow widths, regular/fullscreen and
  your terminal/tmux bindings. The above-editor widget must remain visible even
  with a replacement footer. Check no stale label after cancellation/shutdown.
- Synthetic tests cover 12/20/80-column native stock/replacement footer rendering
  and source-dialog focus; they do not prove your complete live layout or compositor.

## Correction and provider matrix

Once you approve explicit `provider/modelId` candidates, test minimal edits,
technical names, ambiguous/multilingual phrases and intent preservation. Start
with `context.maxChars: 0` if you do not want conversation history sent. Correction
is fallible; inspect before sending.

Test ordered unavailable-first/success-next, exhaustion/raw notice and cancellation
without fallback. Each attempted provider receives transcript/context; cancellation
cannot recall sent data. Never add an unapproved remote candidate for convenience.
Local success does not establish remote STT/auth or correction-provider compatibility.
