import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
const load = async entry => { const b = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' }); return import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64')); };
const { wakePattern, quickTasks, taskMessage, mentionsAssistant } = await load('src/server/tasks.ts');
const { pickRunner, cliSessions, cliGenerate } = await load('src/mcp/runner.ts');
const seg = (seq, text) => ({ id: 's' + seq, seq, startMs: seq * 15000, endMs: (seq + 1) * 15000, status: 'done', text, error: null, tag: null });

test('any assistant name can be the wake word, with the usual speech-recognition spellings', () => {
  const assistant = { name: 'AI助手', wake: wakePattern(['AI助手', 'Codex']) };
  for (const said of ['AI助手，帮我查一下', 'A I 助手帮我算', 'a.i.助手', '爱助手你整理一下', '那个 ai 助 手', 'codex 你看看']) assert.ok(mentionsAssistant(said, assistant), said);
  for (const said of ['我们的助手功能', '找个 AI 产品', '这个手册']) assert.ok(!mentionsAssistant(said, assistant), said);
  assert.ok(wakePattern(['小助手']).test('小 助手，帮我'));
  assert.throws(() => wakePattern([' ', '']), /唤醒词/);
});

test('without an organising model the speech naming the assistant becomes the task, once', () => {
  const assistant = { name: 'AI助手', wake: wakePattern(['AI助手']) };
  const meeting = { segments: [seg(0, '我们先看排期。'), seg(1, 'AI助手，'), seg(2, '帮我把上季度流水和去年同期对比一下。')], aiTasks: [] };
  const [task] = quickTasks(meeting, assistant);
  assert.deepEqual(task.refs, ['s1', 's2'], 'a request split over two segments is one task');
  assert.match(task.instruction, /AI助手，帮我把上季度流水和去年同期对比一下/);
  assert.deepEqual(quickTasks({ ...meeting, aiTasks: [{ refs: ['s1', 's2'] }] }, assistant), [], 'not taken twice');
  assert.deepEqual(quickTasks({ segments: [seg(0, '这个助手功能不错')], aiTasks: [] }, assistant), []);
  const message = taskMessage({ id: 'm', title: '周会', segments: meeting.segments, summaries: [] }, { id: 't1', instruction: task.instruction, quote: task.quote }, 'output');
  assert.match(message, /最后的回复就是交回会议屏幕的结果/); assert.doesNotMatch(message, /submit_task_result/);
});

test('the task runner picks an installed agent CLI and returns its final answer', async () => {
  assert.equal(pickRunner('off', () => '/x'), null);
  assert.deepEqual(pickRunner('auto', bin => bin === 'claude' ? '/bin/claude' : null), { name: 'claude', path: '/bin/claude' }, 'auto takes the first installed');
  assert.deepEqual(pickRunner('auto', bin => bin === 'codex' ? '/bin/codex' : bin === 'claude' ? '/bin/claude' : null).name, 'codex');
  assert.equal(pickRunner('cursor', () => null), null);
  const dir = await mkdtemp('/tmp/meeting-runner-');
  try {
    // A stand-in for claude -p: reads the task from stdin and prints the answer; also records its arguments and environment.
    const fake = path.join(dir, 'claude');
    await writeFile(fake, "#!/usr/bin/env node\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').writeFileSync(process.argv[1]+'.args',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),child:process.env.MEETING_ASSISTANT_TASK_RUN}));if(s.includes('失败'))process.exit(3);console.log('**结果**：收到 '+s.length+' 字的任务');});\n");
    await chmod(fake, 0o755);
    const sessions = cliSessions({ name: 'claude', path: fake }, dir);
    assert.equal(sessions.reply, 'output'); assert.equal(await sessions.workspace(), dir);
    const turn = await sessions.send(dir, await sessions.start(dir), '查一下上季度流水');
    for (let i = 0; i < 100 && await sessions.status(dir, 'local', turn) === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(await sessions.status(dir, 'local', turn), 'completed');
    assert.match(await sessions.output(turn), /收到 8 字的任务/);
    const seen = JSON.parse(await (await import('node:fs/promises')).readFile(fake + '.args', 'utf8'));
    assert.deepEqual(seen.args, ['-p', '--dangerously-skip-permissions', '--output-format', 'text'], 'the task goes through stdin, not the command line');
    assert.equal(seen.child, '1', 'the run is marked so it does not start a meeting server of its own');
    const bad = await sessions.send(dir, 'local', '这个会失败');
    for (let i = 0; i < 100 && await sessions.status(dir, 'local', bad) === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(await sessions.status(dir, 'local', bad), 'failed');
    assert.equal(await sessions.status(dir, 'local', 'nope'), 'unavailable');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without an API key the agent CLI organises: a read-only run whose final answer is the result', async () => {
  const dir = await mkdtemp('/tmp/meeting-organise-');
  try {
    // A stand-in for codex exec: reads the prompt from stdin, writes its answer to the file after -o, records its arguments and environment.
    const fake = path.join(dir, 'codex');
    await writeFile(fake, "#!/usr/bin/env node\nlet s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const fs=require('fs'),a=process.argv.slice(2);fs.writeFileSync(process.argv[1]+'.seen',JSON.stringify({args:a,child:process.env.MEETING_ASSISTANT_TASK_RUN,prompt:s}));if(s.includes('FAIL'))process.exit(3);fs.writeFileSync(a[a.indexOf('-o')+1],'{\"plan\":{\"ready\":true}}');});\n");
    await chmod(fake, 0o755);
    const generate = cliGenerate({ name: 'codex', path: fake }, dir);
    assert.deepEqual(await generate({ instructions: '白板规则', prompt: '{"mode":"append"}' }), { text: '{"plan":{"ready":true}}', model: 'codex' });
    const seen = JSON.parse(await readFile(fake + '.seen', 'utf8'));
    assert.ok(seen.args.includes('read-only'), 'organising never edits files or runs commands');
    assert.ok(!seen.args.some(arg => /dangerously/.test(arg)), 'and never skips approvals');
    assert.equal(seen.child, '1', 'the run is marked so the meeting server it loads stays idle');
    assert.match(seen.prompt, /白板规则[\s\S]*"mode":"append"[\s\S]*不要调用任何工具/);
    await generate({ instructions: '校对', prompt: '{}', model: 'gpt-x' });
    const chosen = JSON.parse(await readFile(fake + '.seen', 'utf8')).args;
    assert.deepEqual(chosen.slice(chosen.indexOf('-m'), chosen.indexOf('-m') + 2), ['-m', 'gpt-x'], 'a chosen model is passed to the CLI');
    assert.ok(chosen.indexOf('-m') < chosen.indexOf('-'), 'before the stdin marker');
    await assert.rejects(generate({ instructions: 'FAIL', prompt: '{}' }), /整理失败/);
    const slow = path.join(dir, 'claude'); await writeFile(slow, '#!/bin/sh\nsleep 5\n'); await chmod(slow, 0o755);
    await assert.rejects(cliGenerate({ name: 'claude', path: slow }, dir, 300)({ instructions: 'x', prompt: '{}' }), /超时/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('captions proofreading rules: corrections must stay about as long as what was said', async () => {
  const { acceptRewrite, rewriteSegments } = await load('src/server/rewrite.ts');
  assert.ok(acceptRewrite('我们下周一在对一下排期', '我们下周一再对一下排期。'));
  assert.ok(acceptRewrite('嗯那个就是我们先做搜索框吧搜索框', '我们先做搜索框吧。'), 'fillers and repeats may go');
  assert.ok(!acceptRewrite('先做搜索框', ''), 'empty is rejected');
  assert.ok(!acceptRewrite('我们下周一再对一下排期，测试资源也要确认', '好的'), 'too short');
  assert.ok(!acceptRewrite('先做搜索框', '先做搜索框，另外推荐位放到第二期，交互稿周五前出，埋点下周对齐'), 'invented content');
  const got = await rewriteSegments({ title: '评审', vocabulary: '', language: 'zh', context: [], items: [{ id: 's1', text: '在对一下' }] },
    async () => ({ text: '```json\n{"s1":"再对一下。","s9":"不该有"}\n```', model: 'm' }), null, 1000);
  assert.deepEqual(got, { s1: '再对一下。' }, 'only the ids asked for, fences tolerated');
});
