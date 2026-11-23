import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const bundle = await build({ entryPoints: ['src/server/api-asr.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { apiAsrConfig, apiTranscriber, apiAsrPrompt } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('cloud recognition is on only when a transcription model is configured; the address and key fall back to the organising model', () => {
  assert.equal(apiAsrConfig({}), null, 'no model: local recognition only, nothing is uploaded');
  assert.deepEqual(apiAsrConfig({ MEETING_ASR_MODEL: 'whisper-1', OPENAI_API_KEY: 'k1' }), { baseUrl: 'https://api.openai.com/v1', key: 'k1', model: 'whisper-1', timeoutMs: 60000 });
  assert.deepEqual(apiAsrConfig({ MEETING_ASR_MODEL: 'm', MEETING_LLM_BASE_URL: 'https://llm.example.com/v1/', MEETING_LLM_API_KEY: 'k2' }), { baseUrl: 'https://llm.example.com/v1', key: 'k2', model: 'm', timeoutMs: 60000 });
  assert.equal(apiAsrConfig({ MEETING_ASR_MODEL: 'm', MEETING_ASR_BASE_URL: 'https://asr.example.com/v1', MEETING_ASR_API_KEY: 'k3', MEETING_LLM_API_KEY: 'k2' }).key, 'k3');
  assert.equal(apiAsrConfig({ MEETING_ASR_MODEL: 'm', MEETING_ASR_BASE_URL: 'http://127.0.0.1:8000/v1' }).baseUrl, 'http://127.0.0.1:8000/v1', 'a server on this computer may use http');
  assert.throws(() => apiAsrConfig({ MEETING_ASR_MODEL: 'm', MEETING_ASR_BASE_URL: 'http://asr.example.com/v1' }), /https/);
});

test('each segment goes to <base>/audio/transcriptions as a multipart upload with model, language and the term list; failures throw so the local recogniser takes over', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'api-asr-'));
  const file = path.join(dir, '000003.wav'); await writeFile(file, Buffer.from('RIFF....WAVE'));
  try {
    const sent = [];
    const ok = apiTranscriber({ baseUrl: 'https://asr.example.com/v1', key: 'secret', model: 'whisper-1' }, async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ text: ' 我们先过一下排期。 ' }), { status: 200 }); });
    assert.deepEqual(await ok({ file, language: 'zh', hotwords: ['AI助手', 'S4版本', 'AI助手'], context: '上一段' }), { text: '我们先过一下排期。', model: 'whisper-1' });
    const { url, init } = sent[0];
    assert.equal(url, 'https://asr.example.com/v1/audio/transcriptions');
    assert.equal(init.headers.authorization, 'Bearer secret');
    assert.deepEqual(Object.keys(init.headers), ['authorization'], 'no other headers');
    const form = init.body;
    assert.equal(form.get('model'), 'whisper-1'); assert.equal(form.get('language'), 'zh'); assert.equal(form.get('response_format'), 'json');
    assert.equal(form.get('prompt'), '会议中可能出现的词：AI助手、S4版本。', 'terms only, without the previous segment');
    assert.equal(form.get('file').name, '000003.wav'); assert.equal(form.get('file').type, 'audio/wav');
    const auto = apiTranscriber({ baseUrl: 'https://asr.example.com/v1', key: '', model: 'm' }, async (_url, init) => { assert.equal(init.body.get('language'), null); assert.equal(init.body.get('prompt'), null); assert.deepEqual(init.headers, {}); return new Response('{"text":""}'); });
    assert.equal((await auto({ file, language: 'auto', hotwords: [], context: '' })).text, '');
    await assert.rejects(apiTranscriber({ baseUrl: 'https://a.example.com', key: 'k', model: 'm' }, async () => new Response('no', { status: 401 }))({ file, language: 'zh', hotwords: [], context: '' }), /HTTP 401/);
    await assert.rejects(apiTranscriber({ baseUrl: 'https://a.example.com', key: 'k', model: 'm' }, async () => new Response('{"nope":1}'))({ file, language: 'zh', hotwords: [], context: '' }), /无法解析/);
    await assert.rejects(apiTranscriber({ baseUrl: 'https://a.example.com', key: 'k', model: 'm' }, async () => { throw new TypeError('fetch failed'); })({ file, language: 'zh', hotwords: [], context: '' }), /请求失败/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the English prompt and an empty term list', () => {
  assert.equal(apiAsrPrompt('en', ['Assistant', 'Q4 plan']), 'Terms that may appear: Assistant, Q4 plan.');
  assert.equal(apiAsrPrompt('zh', [' ', '']), '');
});

