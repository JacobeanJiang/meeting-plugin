import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const bundle = await build({ entryPoints: ['src/server/live-preview.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { LivePreview, MAX_DRAFT_MS } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

/** ms of 16 kHz mono 16-bit audio: a 440 Hz tone, or silence. */
const audio = (ms, loud = true) => { const pcm = Buffer.alloc(ms * 32); if (loud) for (let i = 0; i < ms * 16; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 2 * Math.PI * 440 / 16000)), i * 2); return pcm; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) if (check()) return; assert.fail('timed out'); };
async function preview(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'live-preview-'));
  const calls = []; let changes = 0;
  const file = path.join(dir, 'live-preview.wav');
  const stream = new LivePreview({ file, everyMs: 20, busy: () => false, onLive: () => changes++,
    recognise: async wav => { calls.push(await readFile(wav)); return options.text ? options.text(calls.length) : '第' + calls.length + '稿'; }, ...options.overrides });
  return { stream, calls, file, changes: () => changes, close: async () => { stream.abort(); await rm(dir, { recursive: true, force: true }); } };
}

test('speech not yet saved is recognised as a grey draft with no speaker names, and the WAV is removed after each pass', async () => {
  const t = await preview();
  try {
    t.stream.push(audio(2000));
    await until(() => t.stream.live().sentences.length === 1);
    const wav = t.calls[0];
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 2000 * 32, 'the draft covers all audio heard so far');
    assert.deepEqual(t.stream.live(), { sentences: [{ startMs: 0, endMs: 2000, text: '第1稿', definite: false }], speakerThrough: Number.MAX_SAFE_INTEGER, heardMs: 2000, speakers: false });
    assert.ok(t.changes() >= 1);
    await assert.rejects(access(t.file), 'the audio file does not stay behind');
    assert.equal(t.stream.active, false, 'saved captions never come from the drafts');
    assert.equal(await t.stream.transcribeChunk(0, 2000), null);
    await sleep(100);
    assert.equal(t.calls.length, 1, 'no new audio, no new pass');
  } finally { await t.close(); }
});

test('silence is not sent to the recogniser, and a pass waits while saved chunks are being recognised', async () => {
  let busy = true;
  const t = await preview({ overrides: { busy: () => busy } });
  try {
    t.stream.push(audio(3000, false));
    t.stream.push(audio(1000));
    await sleep(120);
    assert.equal(t.calls.length, 0, 'saved chunks go first');
    busy = false;
    await until(() => t.calls.length === 1);
  } finally { await t.close(); }
  const quiet = await preview();
  try { quiet.stream.push(audio(3000, false)); await sleep(120); assert.equal(quiet.calls.length, 0); assert.deepEqual(quiet.stream.live().sentences, []); }
  finally { await quiet.close(); }
});

test('a saved chunk takes its audio out of the draft and the rest is recognised again right away', async () => {
  const t = await preview();
  try {
    t.stream.push(audio(3000));
    await until(() => t.stream.live().sentences.length === 1);
    t.stream.push(audio(1500));
    t.stream.release(2000);
    assert.deepEqual(t.stream.live().sentences, [], 'the old draft started inside the saved chunk');
    await until(() => t.stream.live().sentences.length === 1);
    assert.equal(t.calls.at(-1).readUInt32LE(40), 2500 * 32, 'only the audio after the saved chunk');
    assert.equal(t.stream.live().sentences[0].startMs, 2000);
  } finally { await t.close(); }
});

test('a long backlog keeps the draft to the latest audio, and a pass started before a saved chunk is dropped', async () => {
  let resolve = null; const sizes = [];
  const t = await preview({ overrides: { recognise: async wav => { sizes.push((await readFile(wav)).readUInt32LE(40)); return new Promise(done => { resolve = done; }); } } });
  try {
    t.stream.push(audio(MAX_DRAFT_MS + 5000));
    await until(() => resolve);
    assert.deepEqual(sizes, [MAX_DRAFT_MS * 32], 'at most MAX_DRAFT_MS of audio');
    t.stream.release(MAX_DRAFT_MS);
    resolve('过期的结果');
    await sleep(50);
    assert.ok(t.stream.live().sentences.every(sentence => sentence.text !== '过期的结果'), 'the stale result is not shown');
    assert.equal(t.stream.live().heardMs, MAX_DRAFT_MS + 5000);
  } finally { await t.close(); }
});

test('a failed pass keeps the previous draft; pause stops passes and finish ends them', async () => {
  let fail = false;
  const t = await preview({ text: count => { if (fail) throw Error('recogniser down'); return '稿' + count; } });
  try {
    t.stream.push(audio(1500));
    await until(() => t.stream.live().sentences.length === 1);
    fail = true; t.stream.push(audio(1000));
    await until(() => t.calls.length === 2);
    await sleep(30);
    assert.equal(t.stream.live().sentences[0].text, '稿1');
    fail = false; t.stream.pause(); t.stream.push(audio(1000));
    await sleep(100);
    assert.equal(t.calls.length, 2, 'paused');
    t.stream.resume();
    await until(() => t.calls.length === 3);
    await t.stream.finish();
    t.stream.push(audio(1000));
    await sleep(100);
    assert.equal(t.calls.length, 3, 'finished');
  } finally { await t.close(); }
});

test('a chunk handed to recognition keeps its draft on screen while the next chunk is drafted, until its caption is saved', async () => {
  const t = await preview();
  try {
    t.stream.push(audio(3000));
    await until(() => t.stream.live().sentences.length === 1);
    assert.equal(await t.stream.transcribeChunk(0, 2500), null, 'the saved chunk is still recognised from its file');
    t.stream.push(audio(1500));
    await until(() => t.stream.live().sentences.length === 2);
    assert.deepEqual(t.stream.live().sentences.map(sentence => [sentence.startMs, sentence.text]), [[0, '第1稿'], [2500, '第2稿']]);
    assert.equal(t.calls.at(-1).readUInt32LE(40), 2000 * 32, 'the next draft starts at the chunk boundary');
    t.stream.release(2500);
    assert.deepEqual(t.stream.live().sentences.map(sentence => sentence.text), ['第2稿'], 'the caption replaces only its own draft');
  } finally { await t.close(); }
});
