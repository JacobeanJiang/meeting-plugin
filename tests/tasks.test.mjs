import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
const load = async entry => { const b = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' }); return import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64')); };
const { wakePattern, quickTasks, taskMessage, mentionsAssistant } = await load('src/server/tasks.ts');
const { pickRunner, cliSessions } = await load('src/mcp/runner.ts');
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
