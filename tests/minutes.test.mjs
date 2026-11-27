import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const load = async entry => { const b = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' }); return import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64')); };
const { generateMinutes, referencedTranscriptLines, transcriptLines, validateMinutesEvidence, TRANSCRIPT_LIMIT } = await load('src/server/minutes.ts');
const { MINUTES_PROMPT } = await load('src/server/minutes-prompt.ts');
const { parseMinutes, renderMinutesHtml, parseTodo, parseDecision, minutesDocument, minutesCitationTimes, stripMinutesCitations, todosFromMinutes } = await load('src/minutes-format.ts');
export const SAMPLE = "# 会议纪要：S4版本资源排期评审\n# 会议概览\n- **主题**：S4版本资源与BUG修复排期\n- **核心目标**：\n1.对齐S4版本美术资源进度\n2.确认战斗模块BUG修复优先级\n\n# 核心方向\n- 按核心议题、业务逻辑和篇幅重心组织；可对适当重要信息加粗，数据严格依据原文提取，禁止虚构\n## 一.S4版本：资源进度同步\n### 1.美术资源交付\n- 交付进度：角色立绘交付率**90%**，场景资源剩余3张\n- 风险：特效资源依赖外包，交付时间**待确认**\n### 2.其他相关进展\n- 音效：主城BGM已完成混音\n## 二.战斗模块：BUG修复与数值平衡\n### 1.BUG修复排期\n- P0问题：技能连招卡顿需本周修复 <script>alert(1)</script>\n\n# 关键决策\n- 【S4版本】上线节奏：本轮只做主城与第一章，第二章延后\n- 【战斗模块】修复优先级：P0 问题优先于数值平衡\n\n# 待办事项\n- 【战斗模块】修复技能连招卡顿 @张三 @李四；协作方：开发、区域团队（下周三前）\n- 【S4版本】确认特效外包交付时间 @王五\n- 【跨项目协作】同步主城BGM至S3版本；协作方：音频组";
const seg = (seq, text) => ({ id: 's' + seq, seq, startMs: seq * 15000, endMs: (seq + 1) * 15000, status: 'done', text, error: null, tag: null });

const SKELETON = "# 会议纪要：S4版本资源排期评审\n# 会议概览\n- **主题**：S4版本资源与BUG修复排期\n- **核心目标**：\n1.对齐S4版本美术资源进度\n\n# 核心方向\n## 一.S4版本：资源进度同步\n### 1.美术资源交付\n### 2.其他相关进展\n## 二.战斗模块：BUG修复\n### 1.BUG修复排期";
const scopeOf = prompt => prompt.split('## 本次输出范围\n')[1] ?? '';
const fake = calls => async input => {
  calls.push(input); const scope = scopeOf(input.prompt);
  if (scope.startsWith('本次只输出纪要骨架')) return { text: '```markdown\n' + SKELETON + '\n```', model: 'm' };
  if (scope.includes('“# 关键决策”这一个模块')) return { text: '好的\n# 关键决策\n- 【S4版本】上线节奏：本轮只做主城', model: 'm' };
  if (scope.includes('“# 待办事项”这一个模块')) return { text: '# 待办事项\n- 【战斗模块】修复技能连招卡顿 @张三（本周）', model: 'm' };
  const topic = scope.match(/中的“(.+?)”。/)?.[1] ?? '?';
  return { text: '### 不该出现的标题\n- 要点：' + topic + '的内容', model: 'm' };
};

test('minutes are built in short requests: skeleton, one per sub-topic, then decisions and actions; the prompt is used verbatim', async () => {
  assert.equal(MINUTES_PROMPT.length, 9637); assert.equal(MINUTES_PROMPT.split('$' + '{contents}').length, 2);
  const [before, after] = MINUTES_PROMPT.split('$' + '{contents}');
  const calls = [];
  const result = await generateMinutes({ segments: [seg(0, '我们 S4 先做主城'), seg(1, '好的'), { ...seg(2, ''), status: 'empty' }, { ...seg(3, 'x'), status: 'failed' }] }, fake(calls), 'chosen');
  assert.equal(calls.length, 1 + 3 + 2, 'skeleton, three sub-topics, decisions, actions'); assert.equal(result.parts, 6);
  for (const call of calls) {
    assert.equal(call.model, 'chosen');
    assert.ok(call.prompt.startsWith(before), 'prompt text before the placeholder unchanged');
    assert.ok(call.prompt.includes(after + '\n\n## 本次输出范围\n'), 'prompt text after the placeholder unchanged, then the part being asked for');
    assert.match(call.prompt, /\[00:00\] \[s0\] 我们 S4 先做主城\n\[00:15\] \[s1\] 好的\n/); assert.doesNotMatch(call.prompt, /\[00:45\]/, 'failed and empty segments are left out');
  }
  const md = result.markdown;
  assert.ok(md.startsWith('# 会议纪要：S4版本资源排期评审'), 'code fences removed');
  assert.ok(md.indexOf('### 1.美术资源交付\n- 要点：1.美术资源交付的内容') > md.indexOf('## 一.S4版本'), 'points sit under their own sub-topic');
  assert.ok(md.indexOf('- 要点：1.BUG修复排期的内容') > md.indexOf('## 二.战斗模块'));
  assert.doesNotMatch(md, /不该出现的标题|好的\n/, 'stray headings and preambles are dropped');
  assert.ok(md.indexOf('# 关键决策') > md.indexOf('BUG修复排期的内容') && md.indexOf('# 待办事项') > md.indexOf('# 关键决策'));
});
test('minutes cite only completed segments with matching verbatim evidence', async () => {
  const meeting = { segments: [
    seg(0, '本轮只做主城，第二章延后'),
    { ...seg(1, '张三周五前修复连招卡顿'), startMs: 0 },
    { ...seg(2, '有风险需要跟进'), status: 'failed' },
  ] };
  assert.deepEqual(transcriptLines(meeting), ['[00:00] 本轮只做主城，第二章延后', '[00:00] 张三周五前修复连招卡顿']);
  assert.deepEqual(referencedTranscriptLines(meeting), ['[00:00] [s0] 本轮只做主城，第二章延后', '[00:00] [s1] 张三周五前修复连招卡顿']);
  const result = await generateMinutes(meeting, async input => {
    const response = await fake([])(input);
    const scope = scopeOf(input.prompt);
    if (scope.startsWith('本次只输出纪要骨架')) {
      response.text = response.text.replace('S4版本资源与BUG修复排期', 'S4版本范围 [[依据:s0|本轮只做主城]]');
    } else if (scope.includes('“# 关键决策”这一个模块')) {
      response.text += ' [[依据:s0|本轮只做主城]] [[依据:s0|第二章延后]] [[依据:s1|本轮只做主城]] [[依据:s42|本轮只做主城]]';
    } else if (scope.includes('“# 待办事项”这一个模块')) {
      response.text = '# 待办事项\n- 【战斗模块】修复连招卡顿 @张三（周五前） [[依据:s1|张三周五前修复连招卡顿]] [[字幕:s0]]';
    } else {
      response.text += ' [[依据:s2|有风险需要跟进]]';
    }
    return response;
  }, null);
  assert.match(result.markdown, /S4版本范围 \[\[字幕:s0\]\]/);
  assert.match(result.markdown, /本轮只做主城 \[\[字幕:s0\]\]\n/);
  assert.match(result.markdown, /修复连招卡顿 @张三（周五前） \[\[字幕:s1\]\]$/);
  assert.equal((result.markdown.match(/\[\[字幕:/g) ?? []).length, 3);
  assert.doesNotMatch(result.markdown, /\[\[依据/);
  assert.equal(validateMinutesEvidence('- 无依据的观点 [[字幕:s0]]\n- 可定位的要点 [[依据:s0|第二章延后]]', meeting), '- 无依据的观点\n- 可定位的要点 [[字幕:s0]]');
});
test('verified citations locate the transcript in the meeting, export as times and preserve todo identities', () => {
  const todo = '发送交付清单 @张三';
  const markdown = '# 会议纪要：排期\n# 待办事项\n- ' + todo + ' [[字幕:s2]] [[字幕:s3]]';
  const times = minutesCitationTimes([seg(2, '发送交付清单'), { ...seg(3, '无可用字幕'), status: 'failed' }]);
  const page = renderMinutesHtml(parseMinutes(markdown), '会议', times);
  assert.match(page, /data-citation="s2"[^>]*>00:30<\/button>/);
  assert.doesNotMatch(page, /data-citation="s3"|\[\[字幕/);
  const exported = minutesDocument(markdown, '排期', '', times);
  assert.match(exported, /<span class="xj-mtg-minutes-citation">00:30<\/span>/);
  assert.doesNotMatch(exported, /data-citation=|\[\[字幕/);
  assert.deepEqual(todosFromMinutes(markdown), [todo]);
  assert.ok(stripMinutesCitations(markdown).endsWith(todo));
});
test('long minutes preserve evidence verified within each condensed portion', async () => {
  const segments = Array.from({ length: 200 }, (_, i) => seg(i, '第' + i + '段：讨论接口排期、测试资源和上线时间，小王负责联调，周五前给结论。'));
  const tail = '最后决定九点上线，小王负责联调';
  segments.push(seg(200, tail));
  const calls = [];
  const result = await generateMinutes({ segments }, async input => {
    const scope = scopeOf(input.prompt);
    if (!scope) {
      if (input.prompt.includes('[s0]')) return { text: '- 联调 [[依据:s0|小王负责联调]] [[依据:s200|最后决定九点上线]]', model: 'm' };
      if (input.prompt.includes('[s200]')) return { text: '- 九点上线 [[依据:s200|最后决定九点上线]]', model: 'm' };
      return { text: '- 排期讨论', model: 'm' };
    }
    calls.push(input);
    if (scope.includes('“# 关键决策”这一个模块')) {
      return { text: '# 关键决策\n- 九点上线 [[依据:s200|最后决定九点上线]] [[依据:s0|周五前给结论]]', model: 'm' };
    }
    return fake([])(input);
  }, null);
  assert.match(calls[0].prompt, /- 联调 \[\[依据:s0\|小王负责联调\]\]\n/);
  assert.equal(calls[0].prompt.split('[[依据:s200|最后决定九点上线]]').length, 2);
  assert.match(result.markdown, /- 九点上线 \[\[字幕:s200\]\]\n/);
  assert.doesNotMatch(result.markdown, /\[\[字幕:s0\]\]|\[\[依据/);
});
test('a failed request is retried once; a long meeting is condensed first and every request fits the model API', async () => {
  let failures = 1; const calls = [];
  const flaky = async input => { if (failures-- > 0) throw Error('PLUGIN_SERVICE_TIMEOUT'); return fake(calls)(input); };
  assert.match((await generateMinutes({ segments: [seg(0, 'a')] }, flaky, null)).markdown, /# 关键决策/);
  await assert.rejects(() => generateMinutes({ segments: [seg(0, 'a')] }, async () => { throw Error('PLUGIN_SERVICE_TIMEOUT'); }, null), /超时/);
  const segments = Array.from({ length: 1400 }, (_, i) => seg(i, '这是一段比较长的会议发言内容，用来模拟两个小时以上的会议转写，包含各种进度和问题的讨论。'));
  const long = []; const condense = [];
  const result = await generateMinutes({ segments }, async input => { if (!input.prompt.includes('## 本次输出范围')) { condense.push(input); return { text: '- 要点' + condense.length, model: 'm' }; } return fake(long)(input); }, null);
  assert.ok(condense.length >= 2, 'condensed part by part'); assert.equal(result.parts, condense.length + long.length);
  for (const call of [...condense, ...long]) assert.ok(call.prompt.length <= 65536, 'each request fits the model API');
  assert.match(long[0].prompt, /会议较长，以下为按时间顺序分段提取的要点/);
  await assert.rejects(() => generateMinutes({ segments: [] }, async () => ({ text: 'x', model: 'm' }), null), /没有可整理/);
  await assert.rejects(() => generateMinutes({ segments: [seg(0, 'a')] }, async () => ({ text: '  ', model: 'm' }), null), /没有返回/);
  await assert.rejects(() => generateMinutes({ segments: [seg(0, 'a')] }, async () => ({ text: '没有结构', model: 'm' }), null), /结构生成失败/);
  await assert.rejects(() => generateMinutes({ segments: [seg(0, 'a')] }, () => new Promise(() => {}), null, 20), /超时/);
  assert.ok(TRANSCRIPT_LIMIT + MINUTES_PROMPT.length < 65536);
});

test('the minutes Markdown renders as structured, escaped HTML', () => {
  const doc = parseMinutes(SAMPLE);
  assert.equal(doc.title, 'S4版本资源排期评审');
  assert.deepEqual(doc.sections.map(s => s.kind), ['overview', 'directions', 'decisions', 'todos']);
  const html = renderMinutesHtml(doc);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /按核心议题、业务逻辑/, 'template guidance is not shown');
  assert.equal((html.match(/class="m-card"/g) || []).length, 2, 'one card per core direction');
  assert.match(html, /<b class="m-key">交付进度<\/b>角色立绘交付率<strong>90%<\/strong>/);
  assert.equal((html.match(/class="m-decision"/g) || []).length, 2);
  assert.deepEqual(parseTodo('【战斗模块】修复技能连招卡顿 @张三 @李四；协作方：开发、区域团队（下周三前）'), { tag: '战斗模块', task: '修复技能连招卡顿', people: ['张三', '李四'], teams: '开发、区域团队', due: '下周三前' });
  assert.equal(parseTodo('【文档】发送 PPT；协作方：供方。').teams,'供方');
  assert.deepEqual(parseTodo('【S4版本】确认特效外包交付时间'), { tag: 'S4版本', task: '确认特效外包交付时间', people: [], teams: null, due: null });
  assert.deepEqual(parseDecision('【S4版本】上线节奏：本轮只做主城与第一章'), { tag: 'S4版本', title: '上线节奏', body: '本轮只做主城与第一章' });
  assert.match(html, /<p class="m-stats"><span><b>2<\/b>个方向<\/span><span><b>3<\/b>个主题<\/span><span><b>2<\/b>项决策<\/span><span><b>3<\/b>项待办<\/span><\/p>/, 'what the minutes hold, counted');
  assert.match(html, /<p class="m-dek">S4版本资源与BUG修复排期<\/p>/); assert.equal((html.match(/<span class="m-n">0\d<\/span>/g) || []).length, 2, 'goals numbered');
  assert.match(html, /<span class="m-num">01<\/span><h3 class="m-card-title">S4版本：资源进度同步<\/h3>/, 'chapter numbers replace the model\'s own'); assert.match(html, /<h4 class="m-sub"><span class="m-sub-n">2<\/span>其他相关进展<\/h4>/);
  assert.match(renderMinutesHtml(doc, '11月19日 <b>15:01</b>'), /<span class="m-meta-line">11月19日 &lt;b&gt;15:01&lt;\/b&gt;<\/span>/, 'the meta line is escaped');
  const page = minutesDocument(SAMPLE, '备用标题');
  assert.match(page, /^<!doctype html>/); assert.match(page, /<title>S4版本资源排期评审<\/title>/); assert.match(page, /name="viewport"/); assert.doesNotMatch(page, /<script/);
  const loose = renderMinutesHtml(parseMinutes('会议没有按格式输出\n- 一点内容 <b>x</b>'));
  assert.match(loose, /一点内容 &lt;b&gt;x&lt;\/b&gt;/, 'unexpected output still shows as escaped text');
});


test('the minutes follow a length budget set by how much was said', async () => {
  const { minutesBudget } = await load('src/server/minutes.ts');
  assert.deepEqual([minutesBudget(1500).topics, minutesBudget(5000).topics, minutesBudget(17000).topics, minutesBudget(90000).topics], [3, 6, 11, 14]);
  const calls = [];
  const wordy = async input => { const scope = scopeOf(input.prompt); if (!scope.startsWith('本次只输出纪要骨架') && !scope.includes('关键决策')) { calls.push(input); return { text: Array.from({ length: 8 }, (_, i) => '- 要点' + i + '：内容').join('\n'), model: 'm' }; } return fake(calls)(input); };
  const result = await generateMinutes({ segments: [seg(0, '我们 S4 先做主城'), seg(1, '好的')] }, wordy, null);
  const skeleton = calls.find(call => scopeOf(call.prompt).startsWith('本次只输出纪要骨架'));
  assert.match(scopeOf(skeleton.prompt), /按短篇幅处理。一级方向不超过 2 个，二级主题合计不超过 3 个/);
  const topic = calls.find(call => scopeOf(call.prompt).includes('二级主题下的要点'));
  assert.match(scopeOf(topic.prompt), /只写 1–3 条最重要的要点，每条不超过 50 字/);
  const under = result.markdown.split('### 1.美术资源交付\n')[1].split('\n###')[0].split('\n').filter(line => line.startsWith('- '));
  assert.equal(under.length, 4, 'a model that ignores the budget is held to one point more than asked');
});

test('a long meeting: decisions and action items are asked for separately; one that times out leaves the rest of the minutes', async () => {
  const segments = Array.from({ length: 200 }, (_, i) => seg(i, '第' + i + '段：讨论接口排期、测试资源和上线时间，小王负责联调，周五前给结论。'));
  const calls = [];
  const generate = async input => { const scope = scopeOf(input.prompt); calls.push(scope ? 'ask' : 'condense'); if (scope.includes('“# 待办事项”这一个模块')) throw Error('PLUGIN_SERVICE_TIMEOUT'); return fake([])(input); };
  const result = await generateMinutes({ segments }, generate, null);
  assert.ok(calls.filter(kind => kind === 'condense').length >= 3, 'a transcript over 8 000 characters is condensed in short parts');
  assert.match(result.markdown, /# 关键决策\n- 【S4版本】/);
  assert.match(result.markdown, /# 待办事项\n\n本部分没有生成成功/);
  assert.doesNotMatch(result.markdown.split('# 待办事项')[1], /^- /m, 'the note is not an action item');
});
