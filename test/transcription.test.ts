import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { transcribe } from "../src/transcription.ts";
import { fixtureWav } from "./audio-fixture.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function audio() {
  const dir = await mkdtemp(join(tmpdir(), "oaistt-http-test-")); dirs.push(dir);
  const path = join(dir, "fixture.wav"); const wav = fixtureWav(); await writeFile(path, wav, { mode: 0o600 });
  return { path, bytes: wav.length };
}
const settings = () => parseConfig({ transcription: { apiKeyEnv: null, model: "fixture-stt" } });

test("real loopback multipart contains WAV/model/json/language only, explicit auth, no chat", async () => {
  const server = createServer();
  let calls = 0;
  server.on("request", async (req, res) => {
    calls++;
    assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/audio/transcriptions");
    assert.equal(req.headers.authorization, "Bearer synthetic-fixture-value");
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    assert.equal(body.includes(fixtureWav()), true);
    const fields = body.toString("latin1");
    assert.match(fields, /name="file"; filename="dictation.wav"/);
    assert.match(fields, /Content-Type: audio\/wav/);
    for (const field of ["model", "response_format", "language"]) assert.match(fields, new RegExp(`name="${field}"`));
    assert.match(fields, /fixture-stt/); assert.match(fields, /\r\njson\r\n/); assert.match(fields, /\r\nde\r\n/);
    assert.doesNotMatch(fields, /messages|prompt|context/);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ text: " synthetic result " }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const config = settings(); config.transcription.endpoint = `http://127.0.0.1:${address.port}/v1/audio/transcriptions`;
    config.transcription.language = "de";
    config.transcription.apiKeyEnv = "FIXTURE_STT_KEY";
    assert.equal(await transcribe(await audio(), config, new AbortController().signal, "synthetic-fixture-value"), "synthetic result");
    assert.equal(calls, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
});

test("unauthenticated local request omits auth/language and rejects automatic redirect", async () => {
  const file = await audio();
  let called = false;
  const fetcher: typeof fetch = async (_url, init) => {
    called = true; assert.equal(init!.redirect, "error");
    assert.deepEqual(init!.headers, {});
    assert.equal((init!.body as FormData).has("language"), false);
    return new Response(JSON.stringify({ text: "fixture" }));
  };
  assert.equal(await transcribe(file, settings(), new AbortController().signal, undefined, fetcher), "fixture");
  assert.equal(called, true);
});

for (const response of [
  () => new Response("synthetic-secret-error", { status: 401 }),
  () => new Response("not-json-synthetic-secret"),
  () => new Response(JSON.stringify({ text: "" })),
  () => new Response(JSON.stringify({ text: 12 })),
  () => new Response(JSON.stringify({ other: "synthetic-secret" })),
  () => new Response(JSON.stringify({ text: "bad\u001btext" })),
  () => new Response(JSON.stringify({ text: "x".repeat(64001) })),
  () => new Response("x".repeat(262145)),
  () => new Response("{}", { headers: { "content-length": "262145" } }),
  () => new Response(new Uint8Array([123, 34, 116, 101, 120, 116, 34, 58, 34, 255, 34, 125])),
]) {
  test("invalid/provider/oversized response rejected without echoing body", async () => {
    await assert.rejects(transcribe(await audio(), settings(), new AbortController().signal, undefined,
      async () => response()), (error: unknown) => error instanceof Error && !error.message.includes("synthetic-secret"));
  });
}

test("invalid/incomplete/silent/changed WAV never starts a request", async () => {
  for (const mode of ["silence", "partial", "changed", "limit"] as const) {
    const file = await audio(); const config = settings();
    if (mode === "silence") await writeFile(file.path, fixtureWav(128, true));
    if (mode === "partial") { await writeFile(file.path, Buffer.alloc(50)); file.bytes = 50; }
    if (mode === "changed") file.bytes++;
    if (mode === "limit") config.recorder.maxBytes = 44;
    let calls = 0;
    await assert.rejects(transcribe(file, config, new AbortController().signal, undefined,
      async () => { calls++; return new Response('{"text":"fixture"}'); }));
    assert.equal(calls, 0);
  }
});

test("cancellation and deadline settle despite a fetch implementation ignoring signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const file = await audio(); const config = settings(); config.transcription.timeoutSeconds = 1;
  const parent = new AbortController();
  let started!: () => void; const requested = new Promise<void>((resolve) => { started = resolve; });
  let owned!: AbortSignal;
  const work = transcribe(file, config, parent.signal, undefined, async (_url, init) => {
    owned = init!.signal!; started(); return new Promise(() => {});
  });
  await requested; parent.abort(); await assert.rejects(work); assert.equal(owned.aborted, true);
  const timeout = transcribe(file, config, new AbortController().signal, undefined, async () => new Promise(() => {}));
  t.mock.timers.tick(1000); await assert.rejects(timeout, /timed out/);
});

test("missing or inconsistent auth is refused before file access/request", async () => {
  for (const [config, key] of [[parseConfig({}), undefined], [settings(), "synthetic-fixture-value"],
    [parseConfig({}), "synthetic\nvalue"]] as const) {
    let calls = 0;
    await assert.rejects(transcribe({ path: "/nonexistent-synthetic.wav", bytes: 100 }, config,
      new AbortController().signal, key, async () => { calls++; return new Response('{}'); }),
    (error: unknown) => error instanceof Error && /credential unavailable/.test(error.message) && !error.message.includes("synthetic"));
    assert.equal(calls, 0);
  }
});
