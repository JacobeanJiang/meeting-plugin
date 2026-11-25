import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Exercises the built MCP server over stdio, the way an agent (Codex, Claude Code, Cursor …) talks to it.
const server = process.env.MEETING_MCP_SERVER || fileURLToPath(new URL('../dist-mcp/' + (process.platform === 'win32' ? 'windows' : 'macos') + '/server/index.mjs', import.meta.url));
const id = '6dd7f355-137a-4f33-8357-16f02310f133';
const seg = (seq, text) => ({ id: 's' + seq, seq, startMs: seq * 15000, endMs: (seq + 1) * 15000, status: 'done', text, error: null, tag: null });
async function start(env = {}) {
  const home = await mkdtemp('/tmp/meeting-mcp-');
  const data = path.join(home, 'data'); await mkdir(path.join(data, 'sessions'), { recursive: true });
  // Pretend the speech models are already present, so nothing is downloaded.
  const models = path.join(home, 'xdg/voxtype/models'); await mkdir(models, { recursive: true });
  for (const [name, size] of [['ggml-large-v3-turbo-q5_0.bin', 574041195], ['ggml-silero-vad.bin', 885098]]) { const h = await open(path.join(models, name), 'w'); await h.truncate(size); await h.close(); }
  const record = { id, title: '接口排期评审', startedAt: Date.now() - 120000, endedAt: Date.now(), phase: 'complete', notes: [], summaryThrough: -1, summaryAt: null, summaryState: 'idle', summaryError: null, error: null, audioFiles: {}, sessionDir: path.join(data, 'audio', id),
    segments: [seg(0, '我们先对齐接口排期，首页搜索框放在第一期。'), seg(1, '推荐位的数据还没准备好，所以放到第二期。'), seg(2, '小王周五前出交互稿，埋点口径下周一和数据组对齐。'), seg(3, '测试资源下周一确认，如果推荐位数据延期，第二期整体顺延一周，产品这边负责同步给运营。')] };
  await writeFile(path.join(data, 'sessions', id + '.json'), JSON.stringify(record));
  const session = connect(home, env);
  return { home, data, ...session, close: async (keepHome = false) => { await session.end(); if (!keepHome) await rm(home, { recursive: true, force: true }); } };
}
/** One agent session: its own server process on the given data folder, as an agent app starts one per conversation. */
function connect(home, env = {}) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, MEETING_ASSISTANT_HOME: home, XDG_DATA_HOME: path.join(home, 'xdg'), MEETING_OPEN_BROWSER: '0', MEETING_LLM_API_KEY: '', OPENAI_API_KEY: '', MEETING_LLM_BASE_URL: '', MEETING_ASR_MODEL: '', MEETING_ASR_BASE_URL: '', MEETING_ASR_API_KEY: '', MEETING_TASK_RUNNER: 'off', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let next = 1; const stray = [];
  createInterface({ input: child.stdout }).on('line', line => { let message; try { message = JSON.parse(line); } catch { stray.push(line); return; } pending.get(message.id)?.(message); pending.delete(message.id); });
  const request = (method, params) => new Promise((resolve, reject) => { const n = next++; const timer = setTimeout(() => reject(Error('timeout ' + method)), 20000); pending.set(n, message => { clearTimeout(timer); resolve(message); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const message = await request('tools/call', { name, arguments: args }); const result = message.result; return { error: result.isError ? result.content[0].text : null, value: result.isError ? null : JSON.parse(result.content[0].text) }; };
  const exited = new Promise(resolve => child.once('exit', resolve));
  return { request, call, stray, pid: child.pid, end: async () => { child.stdin.end(); await exited; } };
}

test('an agent connects over stdio, lists the tools and reads, opens and exports a meeting', async () => {
  const t = await start();
  try {
    const init = await t.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'meeting-assistant'); assert.ok(init.result.capabilities.tools); assert.match(init.result.instructions, /meeting_start/);
    const list = await t.request('tools/list', {});
    assert.deepEqual(list.result.tools.map(tool => tool.name).sort(), ['meeting_control', 'meeting_export', 'meeting_list', 'meeting_minutes', 'meeting_open', 'meeting_read', 'meeting_save_minutes', 'meeting_set_layout', 'meeting_start', 'meeting_wait_changes', 'meeting_write_board'].sort());
    for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(list.result.tools.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name).sort(), ['meeting_list', 'meeting_read', 'meeting_wait_changes']);
    const meetings = await t.call('meeting_list');
    assert.equal(meetings.value.current, id); assert.equal(meetings.value.meetings[0].title, '接口排期评审');
    const read = await t.call('meeting_read', { afterSeq: 0 });
    assert.equal(read.value.phase, 'complete'); assert.deepEqual(read.value.transcript.map(s => s.id), ['s1', 's2', 's3']); assert.equal(read.value.minutes, null); assert.ok(read.value.revision);
    const waited = await t.call('meeting_wait_changes', { afterRevision: read.value.revision, waitMs: 600 });
    assert.equal(waited.value.changed, false);
    const opened = await t.call('meeting_open', { id });
    assert.equal(opened.value.openedInBrowser, false); assert.equal(opened.value.organisingModel, null);
    const html = await (await fetch(opened.value.url)).text();
    assert.match(html, /<title>会议白板<\/title>/); assert.match(html, /<body data-live-map /); assert.match(html, /<body[^>]*class="no-ai /, 'background AI tasks are hidden');
    const state = await (await fetch(new URL('api', opened.value.url))).json();
    assert.equal(state.snapshot.meeting.id, id); assert.equal(state.snapshot.settings.aiTasks, false); assert.equal(state.snapshot.settings.autoSummary, false, 'no organising model: live organising stays off');
    assert.match((await t.call('meeting_control', { action: 'jump' })).error, /pause、resume 或 stop/);
    assert.match((await t.call('meeting_read', { id: 'no-such-meeting' })).error, /会议/);
    assert.deepEqual(t.stray, [], 'nothing but protocol messages on stdout');
  } finally { await t.close(); }
});

test('without an organising model the agent writes the minutes from the prompt and saves them', async () => {
  const t = await start();
  try {
    await t.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const asked = await t.call('meeting_minutes');
    assert.equal(asked.value.mode, 'agent'); assert.match(asked.value.prompt, /\[00:15\] 推荐位的数据还没准备好/); assert.doesNotMatch(asked.value.prompt, /\$\{contents\}/);
    const saved = await t.call('meeting_save_minutes', { markdown: '# 会议纪要：接口排期评审\n# 会议概览\n- **主题**：接口排期\n\n# 待办事项\n- 【首页】出交互稿 @小王（周五前）' });
    assert.match(await readFile(saved.value.html, 'utf8'), /class="m-at">@小王/);
    const again = await t.call('meeting_minutes');
    assert.equal(again.value.state, 'ready'); assert.equal(again.value.by, 'agent');
    const exported = await t.call('meeting_export');
    assert.match(await readFile(exported.value.markdown, 'utf8'), /小王周五前出交互稿/); assert.ok(exported.value.html);
  } finally { await t.close(); }
});

test('with an OpenAI-compatible model configured, minutes are generated by the server', async () => {
  const http = await import('node:http');
  const requests = [];
  const llm = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const parsed = JSON.parse(body); requests.push({ auth: req.headers.authorization, model: parsed.model, path: req.url });
    const scope = parsed.messages[1].content.split('## 本次输出范围\n')[1] ?? '';
    const text = scope.startsWith('本次只输出纪要骨架') ? '# 会议纪要：接口排期评审\n# 会议概览\n- **主题**：接口排期\n\n# 核心方向\n## 一.首页改版\n### 1.排期' : scope.includes('关键决策') ? '# 待办事项\n- 【首页】出交互稿 @小王（周五前）' : '- 排期：搜索框放第一期，推荐位放第二期';
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: parsed.model, choices: [{ message: { content: text } }] }));
  });
  await new Promise(resolve => llm.listen(0, '127.0.0.1', resolve));
  const t = await start({ MEETING_LLM_BASE_URL: 'http://127.0.0.1:' + llm.address().port + '/v1', MEETING_LLM_API_KEY: 'test-key', MEETING_LLM_MODEL: 'my-model' });
  try {
    await t.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const minutes = await t.call('meeting_minutes');
    assert.equal(minutes.error, null);
    assert.equal(minutes.value.state, 'ready'); assert.match(minutes.value.markdown, /搜索框放第一期/); assert.equal(minutes.value.by, 'my-model');
    assert.ok(requests.every(r => r.auth === 'Bearer test-key' && r.model === 'my-model' && r.path === '/v1/chat/completions'));
  } finally { await t.close(); llm.close(); }
});


test('with an agent CLI installed, work asked for in the meeting is on; every agent session gets the tools and the first one serves them', async () => {
  const bin = await mkdtemp('/tmp/meeting-bin-');
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\ncat >/dev/null; echo done\n'); await (await import('node:fs/promises')).chmod(path.join(bin, 'claude'), 0o755);
  // The first session's server exits as soon as its own session closes, so the second one can take over.
  const t = await start({ MEETING_TASK_RUNNER: 'claude', PATH: bin + ':' + process.env.PATH, MEETING_ASSISTANT_NAME: '小助', MEETING_REMOTE_IDLE_MS: '0' });
  let second = null;
  try {
    const init = await t.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.match(init.result.instructions, /addresses "小助" with a request, it is carried out in the background by claude/);
    assert.match(init.result.instructions, /organised by the claude CLI on this computer/);
    const opened = await t.call('meeting_open', { id });
    assert.equal(opened.value.taskRunner, 'claude'); assert.equal(opened.value.assistantName, '小助'); assert.equal(opened.value.organisingModel, 'claude（本机命令行）');
    const html = await (await fetch(opened.value.url)).text();
    assert.doesNotMatch(html, /<body[^>]*class="no-ai /); assert.doesNotMatch(html, /AI 助手/); assert.match(html, /会上说“小助，帮我……”/);
    const state = await (await fetch(new URL('api', opened.value.url))).json();
    assert.equal(state.snapshot.settings.aiTasks, true);
    assert.equal(state.snapshot.settings.autoSummary, true, 'the agent CLI organises the board: live organising is on without an API key');
    assert.deepEqual((await t.call('meeting_read')).value.aiTasks, []);
    // A task run loads the same configuration but gets no meeting tools.
    const task = connect(t.home, { MEETING_ASSISTANT_TASK_RUN: '1' });
    assert.match((await task.request('initialize', {})).result.instructions, /carries out a task requested in a meeting/);
    assert.deepEqual((await task.request('tools/list', {})).result.tools, []);
    await task.end();
    // A second agent session gets every tool; its calls are served by the first session's server and see the same meeting.
    second = connect(t.home, { MEETING_TASK_RUNNER: 'claude', PATH: bin + ':' + process.env.PATH });
    await second.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    assert.equal((await second.request('tools/list', {})).result.tools.length, 11);
    const listed = await second.call('meeting_list');
    assert.equal(listed.error, null); assert.equal(listed.value.current, id);
    const viaFirst = await second.call('meeting_open', { id });
    assert.equal(viaFirst.value.url, opened.value.url, 'the same page, served by the first session');
    assert.match((await second.call('meeting_control', { action: 'jump' })).error, /pause、resume 或 stop/, 'errors come back as they are');
    // The first session closes: the second takes over with the same records and its own page.
    await t.close(true);
    const after = await second.call('meeting_list');
    assert.equal(after.error, null); assert.equal(after.value.current, id);
    const own = await second.call('meeting_open', { id });
    assert.notEqual(own.value.url, opened.value.url); assert.equal(own.value.taskRunner, 'claude');
    assert.deepEqual(second.stray, []);
  } finally { await second?.end(); await rm(t.home, { recursive: true, force: true }); await rm(bin, { recursive: true, force: true }); }
});

test('cloud speech recognition is off unless a transcription model is configured, and the meeting page offers the choice only then', async () => {
  const t = await start();
  try {
    const off = await t.call('meeting_open', { id });
    assert.match(off.value.speechRecognition, /^本机识别/);
    assert.equal((await (await fetch(new URL('api/settings', off.value.url))).json()).environment.cloudAsr, false);
  } finally { await t.close(); }
  const u = await start({ MEETING_ASR_MODEL: 'whisper-1', MEETING_ASR_BASE_URL: 'http://127.0.0.1:9/v1', MEETING_ASR_API_KEY: 'k' });
  try {
    const on = await u.call('meeting_open', { id });
    assert.match(on.value.speechRecognition, /^whisper-1（第三方识别接口/);
    assert.equal((await (await fetch(new URL('api/settings', on.value.url))).json()).environment.cloudAsr, true);
  } finally { await u.close(); }
});


test('a third-party recogniser and live captions can be set in <home>/config.json; the environment wins and a broken file is reported', async () => {
  const t = await start();
  await t.close(true);
  try {
    await writeFile(path.join(t.home, 'config.json'), JSON.stringify({ MEETING_ASR_MODEL: 'whisper-large-v3-turbo', MEETING_ASR_BASE_URL: 'http://127.0.0.1:9/v1', MEETING_ASR_API_KEY: 'file-key', IGNORED: 'x' }));
    let session = connect(t.home);
    let opened = await session.call('meeting_open', { id });
    assert.match(opened.value.speechRecognition, /^whisper-large-v3-turbo（第三方识别接口/);
    assert.equal(opened.value.liveCaptions, true, 'live captions are on by default');
    assert.equal(opened.value.configProblem, undefined);
    const settings = await (await fetch(new URL('api/settings', opened.value.url))).json();
    assert.equal(settings.environment.cloudAsr, true, 'the page offers to switch back to local recognition');
    assert.equal(settings.environment.voiceprintTest, undefined);
    await session.end();
    session = connect(t.home, { MEETING_ASR_MODEL: 'env-model', MEETING_LIVE_CAPTIONS: '0' });
    opened = await session.call('meeting_open', { id });
    assert.match(opened.value.speechRecognition, /^env-model/); assert.equal(opened.value.liveCaptions, false);
    await session.end();
    await writeFile(path.join(t.home, 'config.json'), '{ not json');
    session = connect(t.home);
    opened = await session.call('meeting_open', { id });
    assert.match(opened.value.configProblem, /config\.json/); assert.match(opened.value.speechRecognition, /^本机识别/);
    const read = await session.call('meeting_read', { id });
    assert.equal(read.value.liveCaption, null);
    await session.end();
  } finally { await rm(t.home, { recursive: true, force: true }); }
});
