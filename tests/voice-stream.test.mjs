import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';

const bundle = await build({ entryPoints: ['src/server/voice-stream.ts'], bundle: true, packages: 'external', format: 'cjs', platform: 'node', write: false });
const module = { exports: {} };
const { createRequire } = await import('node:module');
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const { VoiceStream } = module.exports;

test('streamed PCM holds for ready, keeps timed final subtitles and clears a rejected speaker', async () => {
  const service = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(service, 'listening');
  const names = [];
  const stream = new VoiceStream(new URL(`ws://127.0.0.1:${service.address().port}`), 'fixture-token', event => names.push(event));
  try {
    stream.push(Buffer.alloc(6400));
    const [socket, req] = await once(service, 'connection');
    assert.equal(req.headers.authorization, 'Bearer fixture-token');
    const message = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'ready' }));
    const [pcm, binary] = await message;
    assert.equal(binary, true);
    assert.equal(pcm.length, 6400);
    const final = { text: '按期交付', startMs: 0, endMs: 160, definite: true };
    socket.send(JSON.stringify({ type: 'transcript', utterances: [{ ...final, definite: false }, final] }));
    socket.send(JSON.stringify({ type: 'transcript', utterances: [final] }));
    socket.send(JSON.stringify({ type: 'speaker', endMs: 100, name: '示例成员' }));
    socket.send(JSON.stringify({ type: 'speaker', endMs: 200, name: null }));
    const finishFrame = once(socket, 'message');
    const done = stream.finish();
    const [finish, isBinary] = await finishFrame;
    assert.equal(isBinary, false);
    assert.equal(finish.toString(), 'finish');
    socket.send(JSON.stringify({ type: 'done' }));
    await done;
    assert.deepEqual(stream.live().sentences.map(row => row.text), ['按期交付'], 'final sentences stay on screen after the stream ends until their chunk is saved');
    assert.equal(stream.live().speakerThrough, Number.MAX_SAFE_INTEGER, 'no more speaker results will come');
    assert.deepEqual(await stream.transcribeChunk(0, 200), [{ text: '按期交付', startMs: 0, endMs: 160 }]);
    assert.deepEqual(names, [{ atMs: 100, name: '示例成员' }, { atMs: 200, name: null }]);
  } finally {
    stream.abort();
    await new Promise(resolve => service.close(resolve));
  }
});

test('a disconnected stream gives an unconfirmed chunk back to the WAV recognizer', async () => {
  const service = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(service, 'listening');
  const stream = new VoiceStream(new URL(`ws://127.0.0.1:${service.address().port}`), 'fixture-token', () => {});
  try {
    const [socket] = await once(service, 'connection');
    const result = stream.transcribeChunk(0, 15000);
    socket.terminate();
    assert.equal(await result, null);
    assert.equal(stream.active, false);
    await stream.finish();
  } finally {
    stream.abort();
    await new Promise(resolve => service.close(resolve));
  }
});

test('drafts show live, a quiet chunk end saves without waiting, and handed sentences stay until released', async () => {
  const service = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(service, 'listening');
  let changed = 0;
  const stream = new VoiceStream(new URL(`ws://127.0.0.1:${service.address().port}`), 'fixture-token', () => {}, () => changed++);
  try {
    const [socket] = await once(service, 'connection');
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'ready' }));
    stream.push(Buffer.alloc(32 * 1000));
    await ready;
    socket.send(JSON.stringify({ type: 'transcript', utterances: [{ text: '大家', startMs: 100, endMs: 400, definite: false }] }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(stream.live().sentences, [{ text: '大家', startMs: 100, endMs: 400, definite: false }]);
    assert.ok(changed > 0, 'a draft tells the controller the live view changed');
    socket.send(JSON.stringify({ type: 'transcript', utterances: [{ text: '大家好。', startMs: 100, endMs: 600, definite: true }] }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(stream.live().sentences, [{ text: '大家好。', startMs: 100, endMs: 600, definite: true }]);
    // The chunk ends at 1000 ms; 2.5 s more audio with no draft before it is enough.
    const result = stream.transcribeChunk(0, 1000);
    stream.push(Buffer.alloc(32 * 2600));
    assert.deepEqual(await result, [{ text: '大家好。', startMs: 100, endMs: 600 }]);
    assert.equal(stream.live().sentences.length, 1, 'still shown until the caption is saved');
    stream.release(1000);
    assert.deepEqual(stream.live().sentences, []);
    assert.equal(stream.live().heardMs, 3600);
  } finally {
    stream.abort();
    await new Promise(resolve => service.close(resolve));
  }
});

test('a final sentence that starts in an already saved chunk sends the next chunk to its WAV', async () => {
  const service = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(service, 'listening');
  const stream = new VoiceStream(new URL(`ws://127.0.0.1:${service.address().port}`), 'fixture-token', () => {});
  try {
    const [socket] = await once(service, 'connection');
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'ready' }));
    stream.push(Buffer.alloc(32 * 4000));
    await ready;
    assert.deepEqual(await stream.transcribeChunk(0, 1000), [], 'no draft yet, so the first chunk looked quiet');
    socket.send(JSON.stringify({ type: 'transcript', utterances: [{ text: '迟到的话', startMs: 500, endMs: 1500, definite: true }, { text: '后面', startMs: 1600, endMs: 1900, definite: true }] }));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(await stream.transcribeChunk(1000, 1800), null, 'its words from 1000 to 1500 ms are missing from the stream');
  } finally {
    stream.abort();
    await new Promise(resolve => service.close(resolve));
  }
});

const sharedBundle = await build({ entryPoints: ['src/shared.ts'], bundle: true, format: 'cjs', platform: 'node', write: false });
const shared = { exports: {} };
new Function('module', 'exports', 'require', sharedBundle.outputFiles[0].text)(shared, shared.exports, createRequire(import.meta.url));
const { speakerFor } = shared.exports;

test('a sentence waits for its voiceprint result, then takes a name or stays unrecognised', () => {
  const live = (speakerThrough, heardMs = speakerThrough) => ({ sentences: [], speakerThrough, heardMs });
  assert.deepEqual(speakerFor([], 1000, 3000, live(4000)), { names: [], pending: true }, 'results reach only 1 s past the sentence');
  assert.deepEqual(speakerFor([{ atMs: 2000, name: '甲' }], 1000, 3000, live(2000)), { names: ['甲'], pending: false }, 'a name heard during it shows at once');
  assert.deepEqual(speakerFor([{ atMs: 500, name: '甲' }], 1000, 3000, live(5000)), { names: ['甲'], pending: false }, 'the same person going on');
  assert.deepEqual(speakerFor([{ atMs: 500, name: '甲' }, { atMs: 2000, name: null }], 1000, 3000, live(5000)), { names: [], pending: false }, 'unrecognised during it');
  assert.deepEqual(speakerFor([], 1000, 3000, live(-1, 11000)), { names: [], pending: false }, 'no result after 8 s more audio');
  assert.deepEqual(speakerFor([], 1000, 3000, null), { names: [], pending: false }, 'no stream: nothing more will come');
});


test('live sentences are grouped like a saved caption, and one still being spoken stays pending until a name is heard', () => {
  const { liveTurns } = shared.exports;
  const live = { sentences: [{ text: '说完了。', startMs: 0, endMs: 900, definite: true }, { text: '还在说', startMs: 1000, endMs: 2000, definite: false }], speakerThrough: 6000, heardMs: 6000 };
  const [final, draft] = liveTurns(live, [{ atMs: 3000, name: null }]);
  assert.deepEqual(final, { startMs: 0, name: null, pending: false, parts: [{ text: '说完了。', definite: true }] });
  assert.equal(draft.pending, true);
  const [both] = liveTurns(live, [{ atMs: 500, name: '甲' }, { atMs: 1500, name: '甲' }]);
  assert.deepEqual(both, { startMs: 0, name: '甲', pending: false, parts: [{ text: '说完了。', definite: true }, { text: '还在说', definite: false }] }, 'one row per speaker, as the saved caption shows it');
});

test('a chunk whose sentence is still a draft waits for it to be final and keeps showing it', async () => {
  const service = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(service, 'listening');
  const stream = new VoiceStream(new URL(`ws://127.0.0.1:${service.address().port}`), 'fixture-token', () => {});
  try {
    const [socket] = await once(service, 'connection');
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'ready' }));
    stream.push(Buffer.alloc(32 * 1000));
    await ready;
    socket.send(JSON.stringify({ type: 'transcript', utterances: [{ text: '还没说完', startMs: 600, endMs: 1500, definite: false }] }));
    await new Promise(resolve => setTimeout(resolve, 50));
    let saved = null;
    const result = stream.transcribeChunk(0, 1000).then(value => { saved = value; });
    // Long after the chunk, during a pause, the sentence is still a draft: the chunk keeps waiting and the draft stays live.
    stream.push(Buffer.alloc(32 * 9000));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(saved, null);
    assert.deepEqual(stream.live().sentences.map(row => row.text), ['还没说完']);
    socket.send(JSON.stringify({ type: 'transcript', utterances: [{ text: '还没说完的话。', startMs: 600, endMs: 1800, definite: true }, { text: '下一句', startMs: 9000, endMs: 9500, definite: false }] }));
    await result;
    assert.deepEqual(saved, [{ text: '还没说完的话。', startMs: 600, endMs: 1800 }]);
  } finally {
    stream.abort();
    await new Promise(resolve => service.close(resolve));
  }
});

