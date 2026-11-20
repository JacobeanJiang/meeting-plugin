import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
const bundle = await build({ entryPoints: ['src/server/models.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { ModelStore, ASR_MODELS, MODEL_SOURCES } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const VAD = 885098;
// Small stand-ins for the real files: same names, sizes shrunk through the size table.
function files(modelSize) { const model = Buffer.alloc(modelSize, 7); model.write('lmgg', 0, 'latin1'); const vad = Buffer.alloc(VAD, 1); vad.write('lmgg', 0, 'latin1'); return { model, vad }; }
function fakeFetch(content, { failHost = null, cutAt = null, corrupt = false } = {}) {
  const calls = [];
  let cut = cutAt;
  const impl = async (url, init = {}) => {
    calls.push({ url, range: init.headers?.range ?? null });
    if (failHost && url.startsWith(failHost)) return new Response(null, { status: 503 });
    const body = url.endsWith('ggml-silero-v6.2.0.bin') ? content.vad : content.model;
    const from = init.headers?.range ? Number(/bytes=(\d+)-/.exec(init.headers.range)[1]) : 0;
    let slice = body.subarray(from);
    if (corrupt && !url.endsWith('ggml-silero-v6.2.0.bin')) { slice = Buffer.from(slice); slice.write('xxxx', 0, 'latin1'); }
    if (cut !== null && !url.endsWith('ggml-silero-v6.2.0.bin')) { const part = slice.subarray(0, cut); cut = null; return new Response(new ReadableStream({ start(c) { c.enqueue(part); }, pull(c) { c.error(Error('connection reset')); } }), { status: from ? 206 : 200 }); }
    return new Response(slice, { status: from ? 206 : 200 });
  };
  return { impl, calls };
}
async function store(fetchImpl, shared) {
  const root = await mkdtemp('/tmp/meeting-models-'); const states = [];
  const s = new ModelStore(path.join(root, 'models'), state => states.push({ ...state }), fetchImpl, shared ?? path.join(root, 'shared'));
  return { s, root, states };
}
test('downloads the speech detector and the model, reporting progress; resumes after a dropped connection', async () => {
  const size = 3_000_000; ASR_MODELS['large-v3-turbo-q5_0'].size = size;
  const { impl, calls } = fakeFetch(files(size), { cutAt: 1_000_000 });
  const { s, root, states } = await store(impl);
  try {
    const file = await s.ensure('large-v3-turbo-q5_0');
    assert.equal(file, path.join(root, 'models', 'ggml-large-v3-turbo-q5_0.bin'));
    assert.equal((await readFile(file)).length, size);
    assert.ok(calls.some(c => c.range === 'bytes=1000000-'), 'second request continues where the first stopped');
    assert.ok(states.some(st => st.status === 'downloading' && st.total === size));
    assert.equal(s.state.status, 'ready');
    assert.deepEqual((await readdir(path.join(root, 'models'))).sort(), ['ggml-large-v3-turbo-q5_0.bin', 'ggml-silero-vad.bin']);
    assert.equal(await s.ensure('large-v3-turbo-q5_0'), file, 'ready model returns at once');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('falls back to the mirror when huggingface is unavailable', async () => {
  const size = 2_000_000; ASR_MODELS['large-v3-turbo-q5_0'].size = size;
  const { impl, calls } = fakeFetch(files(size), { failHost: MODEL_SOURCES[0] });
  const { s, root } = await store(impl);
  try { await s.ensure('large-v3-turbo-q5_0'); assert.ok(calls.at(-1).url.startsWith('https://hf-mirror.com/')); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('a corrupt download is rejected and reported; nothing half-written is used', async () => {
  const size = 2_000_000; ASR_MODELS['large-v3-turbo-q5_0'].size = size;
  const { impl } = fakeFetch(files(size), { corrupt: true });
  const { s, root } = await store(impl);
  try {
    await assert.rejects(() => s.ensure('large-v3-turbo-q5_0'), /识别模型下载失败（文件校验失败）/);
    assert.equal(s.state.status, 'failed'); assert.equal(await s.locate('large-v3-turbo-q5_0'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('models voxtype already downloaded are reused without any network access; a turbo model is preferred', async () => {
  ASR_MODELS['large-v3-turbo'].size = 1_000_001;
  const shared = await mkdtemp('/tmp/meeting-shared-');
  await writeFile(path.join(shared, 'ggml-large-v3-turbo.bin'), Buffer.alloc(1_000_001));
  await writeFile(path.join(shared, 'ggml-silero-vad.bin'), Buffer.alloc(VAD));
  const { s, root } = await store(async () => { throw Error('no network expected'); }, shared);
  try {
    assert.equal(await s.preferred(null), 'large-v3-turbo');
    assert.equal(await s.ensure('large-v3-turbo'), path.join(shared, 'ggml-large-v3-turbo.bin'));
    assert.deepEqual(await s.installed(), ['large-v3-turbo']);
  } finally { await rm(root, { recursive: true, force: true }); await rm(shared, { recursive: true, force: true }); }
});

