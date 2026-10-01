# pi-oaistt

Microphone dictation into Pi's interactive prompt editor. **Under development;
not yet an installable dictation extension or a v1 release.**

The intended workflow is F8 or `/oaistt` to start/stop, compatible transcription,
optional correction through an explicitly ordered Pi model list, then append to
the latest draft for review. No automatic submission or main-agent cancellation.
Linux TUI is the target; microphone access in containers must be supplied
explicitly by the host.

## Development

Current test baseline: Pi **0.99.2**, Node **22.19+** (tested on 26.10.0).

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Pi dependencies are development fixtures and host-provided peers, not bundled
runtime dependencies. The manifest is temporarily private and does not expose an
extension entry point until the dictation pipeline exists.

The initial implementation establishes a public-API editor boundary and tests
native submit/steer/follow-up routing, including compaction queues. See
[DEVELOPMENT.md](DEVELOPMENT.md) for evidence, limits and remaining work.
