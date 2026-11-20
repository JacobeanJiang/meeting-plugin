import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'meeting-board-test-'));
await build({ entryPoints: [path.join(root, 'src/server/board.ts')], outfile: path.join(scratch, 'board.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'error' });
const { MeetingBoards } = await import(pathToFileURL(path.join(scratch, 'board.mjs')).href);
const assets = path.join(root, 'vendor/assets');
const seg = (seq, text) => ({ id: 's' + seq, seq, startMs: seq * 15000, endMs: (seq + 1) * 15000, status: 'done', text, error: null, tag: null });
const segments = [seg(0, '首页改版先做搜索框'), seg(1, '同意先做搜索框'), seg(2, '小王周五前出交互稿'), seg(3, '推荐位数据还没准备好'), seg(4, '埋点口径要跟数据组对齐'), seg(11, '测试资源下周一确认')];
const item = (id, group, kind, text, refs, extra = {}) => ({ id, group, kind, text, refs, owner: null, due: null, criterion: null, createdAt: 0, updatedAt: 0, previous: null, sub: null, ...extra });
const plan = (form, extra = {}) => ({ theme: '首页改版', center: '首页改版', type: 'review', form, reason: '测试', decidedAt: 0, lockedBy: 'model', pendingForm: null, pendingCount: 0, ...extra });
const meeting = (id, items, extra = {}) => ({ id, title: '需求评审', startedAt: 0, endedAt: null, phase: 'recording', segments, notes: [], summaryThrough: 11, summaryAt: 1, summaryState: 'idle', summaryError: null, error: null, plan: plan('topics'), items, links: [], summaries: [], lastChange: null, requestedForm: null, ...extra });
const snap = m => ({ settings: {}, meeting: m, levelDbfs: null, pending: 0, history: [] });
const docOf = (board, id) => board.documents.find(doc => doc.id === id);
const at = doc => [doc.data.x, doc.data.y];
let n = 0; const fresh = () => (String(++n).repeat(8) + '-1111-4111-8111-111111111111').slice(0, 36);

test('nothing but the title is drawn while the model is still listening', async () => {
  const boards = new MeetingBoards(path.join(scratch, 'd' + n), assets); const id = fresh();
  try { await boards.sync(snap(meeting(id, [], { plan: null }))); assert.deepEqual((await boards.read(id)).documents.map(doc => doc.id), ['meeting-title']); }
  finally { await boards.close(); }
});

test('topics: heading, one-line status, outcome cards first, discussion folded into subtopic blocks, relations end on blocks', async () => {
  const boards = new MeetingBoards(path.join(scratch, 'd' + n), assets); const id = fresh();
  const items = [item('i1', '首页改版', 'proposal', '本期先做搜索框', ['s0']), item('i2', '首页改版', 'risk', '推荐位数据未就绪', ['s3']), item('i3', '首页改版', 'decision', '搜索框放第一期', ['s1', 's0']),
    item('i4', '数据埋点', 'question', '埋点口径待与数据组对齐', ['s4']), item('i5', '首页改版', 'action', '输出交互稿', ['s2'], { owner: '小王', due: '周五前' }),
    item('i6', '首页改版', 'point', '登录要少点几步', ['s2'], { sub: '登录体验' }), item('i7', '首页改版', 'risk', '免登可能有安全问题', ['s3'], { sub: '登录体验' })];
  const links = [{ id: 'i2-i3', from: 'i2', to: 'i3', type: 'causes', label: null }, { id: 'i1-i4', from: 'i1', to: 'i4', type: 'opposes', label: '有分歧' }, { id: 'i6-i7', from: 'i6', to: 'i7', type: 'causes', label: null }];
  const summaries = [{ group: '首页改版', text: '第一期只做搜索框，交互稿周五前出', refs: ['s1'], updatedAt: 0, previous: null }];
  try {
    await boards.sync(snap(meeting(id, items, { links, summaries })));
    const board = await boards.read(id);
    const heads = board.documents.filter(doc => doc.id.startsWith('grp-h-')).sort((a, b) => a.data.x - b.data.x);
    assert.deepEqual(heads.map(doc => doc.data.text), ['首页改版', '数据埋点']); assert.equal(heads[0].data.size, 'large');
    const sum = docOf(board, 'sum-i1').data, decision = docOf(board, 'it-i3').data, action = docOf(board, 'it-i5').data;
    const proposals = docOf(board, 'blk-i1').data, risks = docOf(board, 'blk-i2').data, login = docOf(board, 'blk-i6').data;
    assert.match(sum.text, /第一期只做搜索框，交互稿周五前出 ²/); assert.ok(sum.y < decision.y && decision.y < action.y && action.y < proposals.y, 'status, then outcomes, then discussion');
    assert.equal(decision.color, '#dcf2e4'); assert.match(action.text, /负责人 小王 · 周五前/);
    assert.equal(proposals.text, '**提出的方案**\n• 本期先做搜索框 ¹', 'no per-line label when the block already names it');
    assert.match(risks.text, /^\*\*风险与顾虑\*\*\n• 推荐位数据未就绪 ⁴$/);
    assert.equal(login.text, '**登录体验**\n• 登录要少点几步 ³\n• **风险** 免登可能有安全问题 ⁴', 'one subtopic block mixes kinds with a short label');
    assert.ok(!docOf(board, 'it-i1') && !docOf(board, 'it-i6'), 'discussion lines are not separate cards');
    const arrows = board.documents.filter(doc => doc.id.startsWith('ln-')).map(doc => doc.data);
    const cause = arrows.find(a => a.to === 'it-i3'), clash = arrows.find(a => a.to === 'it-i4');
    assert.equal(cause.from, 'blk-i2'); assert.equal(cause.label, '导致'); assert.deepEqual([cause.fromSide, cause.toSide], ['right', 'right']);
    assert.equal(clash.from, 'blk-i1'); assert.equal(clash.color, 'terracotta'); assert.equal(clash.dash, true); assert.equal(clash.head, 'both'); assert.equal(clash.fromSide, 'right');
    assert.ok(!arrows.some(a => a.from === 'blk-i6' && a.to === 'blk-i6'), 'two lines in the same block get no arrow');
  } finally { await boards.close(); }
});

test('rounds only append: outcome cards keep their place, a revision changes one card, people keep their edits and deletions', async () => {
  const boards = new MeetingBoards(path.join(scratch, 'd' + n), assets); const id = fresh();
  const first = [item('i1', '首页改版', 'point', '本期先做搜索框', ['s0']), item('i2', '首页改版', 'question', '推荐位放哪一期未定', ['s3']), item('i3', '数据埋点', 'point', '埋点口径需对齐', ['s4'])];
  try {
    await boards.sync(snap(meeting(id, first)));
    let board = await boards.read(id);
    const questionAt = at(docOf(board, 'it-i2')); const headAt = at(docOf(board, 'grp-h-i1'));
    const mine = docOf(board, 'blk-i3');
    await boards.write(id, [{ op: 'set', path: 'elements/blk-i3', if_match: mine.sha256, data: { ...mine.data, text: '我自己补充：口径以数据组为准' } }]);
    const second = [first[0], { ...first[1], kind: 'decision', text: '推荐位放第二期', previous: '推荐位放哪一期未定' }, first[2], item('i4', '首页改版', 'point', '交互稿周五前出', ['s2']), item('i5', '测试排期', 'question', '测试资源待确认', ['s11'])];
    await boards.sync(snap(meeting(id, second)));
    board = await boards.read(id);
    assert.deepEqual(at(docOf(board, 'it-i2')), questionAt, 'revised card stays where it was'); assert.deepEqual(at(docOf(board, 'grp-h-i1')), headAt);
    assert.match(docOf(board, 'it-i2').data.text, /结论.*推荐位放第二期/);
    assert.match(docOf(board, 'blk-i1').data.text, /本期先做搜索框 ¹\n• 交互稿周五前出 ³/, 'new discussion appended to its block');
    assert.equal(docOf(board, 'blk-i3').data.text, '我自己补充：口径以数据组为准', 'edited block kept');
    const heads = board.documents.filter(doc => doc.id.startsWith('grp-h-')).sort((a, b) => a.data.x - b.data.x).map(doc => doc.data.text);
    assert.deepEqual(heads, ['首页改版', '数据埋点', '测试排期'], 'new topic opens a column on the right');
    const gone = docOf(board, 'it-i5');
    await boards.write(id, [{ op: 'delete', path: 'elements/it-i5', if_match: gone.sha256 }]);
    await boards.sync(snap(meeting(id, second)));
    board = await boards.read(id);
    assert.ok(!docOf(board, 'it-i5'));
    const revision = board.revision; await boards.sync(snap(meeting(id, second))); assert.equal((await boards.read(id)).revision, revision, 'same ledger writes nothing');
  } finally { await boards.close(); }
});

test('mind map, flow, comparison and progress forms', async () => {
  const boards = new MeetingBoards(path.join(scratch, 'd' + n), assets); const id = fresh();
  try {
    const mm = [item('i1', '现象', 'point', '留存下降', ['s0']), item('i2', '原因', 'point', '引导过长', ['s1']), item('i3', '原因', 'risk', '服务器卡顿', ['s3']), item('i4', '措施', 'decision', '引导缩短', ['s1'])];
    await boards.sync(snap(meeting(id, mm, { plan: plan('mindmap', { center: '留存下滑' }), links: [{ id: 'i2-i4', from: 'i2', to: 'i4', type: 'resolves', label: null }] })));
    let board = await boards.read(id);
    const center = docOf(board, 'mm-center').data;
    assert.equal(center.text, '留存下滑');
    const topics = board.documents.filter(doc => doc.id.startsWith('mm-t-'));
    assert.deepEqual(topics.map(doc => doc.data.text.split('**')[1]).sort(), ['原因', '措施', '现象'].sort(), 'one branch per topic');
    const side = doc => doc.data.x > center.x ? 'right' : 'left';
    const topicOf = name => topics.find(doc => doc.data.text.startsWith('**' + name + '**'));
    assert.deepEqual(['现象', '原因', '措施'].map(name => side(topicOf(name))), ['right', 'left', 'right'], 'topics alternate sides, first on the right');
    assert.ok(docOf(board, 'it-i1').data.x > topicOf('现象').data.x + topicOf('现象').data.w, 'right branch extends rightwards');
    assert.ok(docOf(board, 'it-i2').data.x + docOf(board, 'it-i2').data.w < topicOf('原因').data.x, 'left branch extends leftwards');
    assert.equal(board.documents.filter(doc => doc.id.startsWith('mm-a-')).length, 3, 'centre to each topic');
    assert.equal(board.documents.filter(doc => doc.id.startsWith('mm-e-')).length, 4, 'topic to each viewpoint');
    assert.equal(docOf(board, 'mm-e-i3').data.from, docOf(board, 'mm-e-i2').data.from, 'viewpoints of one topic share its node');
    assert.ok(!board.documents.some(doc => doc.id.startsWith('ln-') || doc.data.type === 'container'), 'no cross links or columns in the mind map');
    assert.match(docOf(board, 'it-i4').data.text, /\*\*结论\*\*/, 'viewpoint kind stays visible');
    const centerMid = center.y + center.h / 2, span = topics.map(doc => [doc.data.y, doc.data.y + doc.data.h]).flat();
    assert.deepEqual(topics.sort((a, b) => a.data.y - b.data.y).length, 3);
    assert.ok(centerMid >= Math.min(...span) && centerMid <= Math.max(...span), 'centre sits beside the branches');
    const steps = [item('i1', '流程', 'step', '功能冻结：停止合入', ['s0']), item('i2', '流程', 'step', '测试回归', ['s1']), item('i3', '流程', 'step', '灰度发布：10%', ['s2']), item('i4', '要点', 'decision', '观察两天后全量', ['s3'])];
    await boards.sync(snap(meeting(id, steps, { plan: plan('flow') })));
    board = await boards.read(id);
    assert.ok(!docOf(board, 'mm-center'), 'previous form removed');
    assert.match(docOf(board, 'it-i1').data.text, /\*\*1\*\* · \*\*功能冻结\*\*\n停止合入/);
    assert.equal(board.documents.filter(doc => doc.id.startsWith('fl-')).length, 2);
    assert.ok(docOf(board, 'it-i4').data.x > docOf(board, 'it-i3').data.x, 'outcomes column beside the flow');
    const cells = [item('i1', '短信', 'cell', '成本较高', ['s0'], { criterion: '成本' }), item('i2', '一键登录', 'cell', '接入快', ['s1'], { criterion: '速度' })];
    await boards.sync(snap(meeting(id, cells, { plan: plan('matrix') })));
    board = await boards.read(id);
    const table = docOf(board, 'mx-table').data;
    assert.equal(table.rows.r0.c1, '短信'); assert.equal(table.rows.r1.c1, '成本较高 ¹'); assert.equal(table.rows.r1.c2, '—');
    const progress = [item('i1', '已完成', 'status', '支付接口联调', ['s0'], { owner: '小王' }), item('i2', '受阻', 'status', '美术资源未交付', ['s3'])];
    await boards.sync(snap(meeting(id, progress, { plan: plan('status') })));
    board = await boards.read(id);
    assert.equal(board.documents.filter(doc => doc.data.type === 'container').length, 4, 'all four progress columns stay in place');
    assert.match(docOf(board, 'it-i1').data.text, /\*\*小王\*\*　支付接口联调/); assert.equal(docOf(board, 'it-i1').data.color, '#dcf2e4');
  } finally { await boards.close(); }
});

test('boards from 0.1 drop untouched raw transcript stickies but keep edited ones', async () => {
  const data = path.join(scratch, 'legacy'); const boards = new MeetingBoards(data, assets); const id = fresh();
  try {
    const dir = path.join(data, 'boards', id); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'meeting-links.json'), JSON.stringify({ published: ['meeting-title', 'transcript-s0', 'transcript-s1'], deleted: [], lastSyncedAt: null }));
    await boards.open(id, '需求评审');
    await boards.write(id, [
      { op: 'set', path: 'elements/meeting-title', if_match: null, data: { type: 'text', x: 80, y: 50, text: '需求评审', size: 'title', color: 'ink', by: 'agent' } },
      { op: 'set', path: 'elements/transcript-s0', if_match: null, data: { type: 'shape', kind: 'rounded', color: 'yellow', x: 80, y: 160, w: 310, h: 220, text: '[00:00–00:15] 原始转写\n咳咳咳', size: 'small', by: 'agent' } },
      { op: 'set', path: 'elements/transcript-s1', if_match: null, data: { type: 'shape', kind: 'rounded', color: 'yellow', x: 430, y: 160, w: 310, h: 220, text: '我自己记的重点', size: 'small', by: 'agent' } }]);
    await boards.sync(snap(meeting(id, [item('i1', '首页改版', 'decision', '先做搜索框', ['s1'])])));
    const board = await boards.read(id);
    assert.ok(!docOf(board, 'transcript-s0')); assert.ok(docOf(board, 'transcript-s1')); assert.ok(docOf(board, 'it-i1'));
  } finally { await boards.close(); }
});
test.after(() => rm(scratch, { recursive: true, force: true }));

test('chapters on the board: the live topic says so, a wrapped-up topic shows its summary and hides folded details', async () => {
  const boards = new MeetingBoards(path.join(scratch, 'd' + n), assets); const id = fresh();
  const items = [item('i1', '首页改版', 'point', '先做搜索框', ['s0'], { sub: '范围', folded: true }), item('i2', '首页改版', 'point', '推荐位推迟', ['s3'], { sub: '范围' }), item('i3', '首页改版', 'decision', '搜索框放第一期', ['s1']),
    item('i4', '数据埋点', 'question', '埋点口径待对齐', ['s4'])];
  const summaries = [{ group: '首页改版', text: '第一期只做搜索框', refs: ['s1'], updatedAt: 0, previous: null }, { group: '数据埋点', text: '口径还没定', refs: ['s4'], updatedAt: 0, previous: null }];
  try {
    await boards.sync(snap(meeting(id, items, { summaries, chapters: { active: '数据埋点', closing: null, closed: ['首页改版'] } })));
    const board = await boards.read(id);
    assert.match(docOf(board, 'sum-i2').data.text, /^\*\*小结\*\*　第一期只做搜索框/);
    assert.match(docOf(board, 'sum-i4').data.text, /^\*\*讨论中\*\*　口径还没定/);
    assert.ok(!docOf(board, 'blk-i1') && docOf(board, 'blk-i2').data.text === '**范围**\n• 推荐位推迟 ⁴', 'folded line leaves the board');
    assert.equal(docOf(board, 'fold-i2').data.text, '已收起 1 条细节，问答和导出中仍可查到');
  } finally { await boards.close(); }
});



test('closing a board while its engine is starting awaits shutdown and forbids a late engine restart',async()=>{
 const boards=new MeetingBoards(path.join(scratch,'shutdown-start'),assets);const id=fresh();
 const opening=boards.open(id,'生命周期测试');const closing=boards.close();
 await Promise.allSettled([opening]);await closing;
 await assert.rejects(()=>boards.open(id,'关闭后'),/正在关闭/);
 await boards.close();
});


test('mind map grows without moving earlier viewpoints sideways, keeps manual edits, and topic boards become mind maps', async () => {
  const boards = new MeetingBoards(path.join(scratch, 'd' + n), assets); const id = fresh();
  try {
    const first = [item('i1', '首页改版', 'point', '搜索框放第一期', ['s0']), item('i2', '首页改版', 'decision', '推荐位推迟', ['s1'])];
    await boards.sync(snap(meeting(id, first, { plan: plan('mindmap', { center: '首页改版' }), summaries: [{ group: '首页改版', text: '第一期只做搜索框', refs: ['s0'], updatedAt: 0, previous: null }], chapters: { active: '首页改版', closing: null, closed: [] } })));
    let board = await boards.read(id);
    const topic = board.documents.find(doc => doc.id.startsWith('mm-t-'));
    assert.match(topic.data.text, /首页改版\*\*　讨论中\n第一期只做搜索框/);
    const x1 = docOf(board, 'it-i1').data.x;
    const edited = docOf(board, 'it-i1');
    await boards.write(id, [{ op: 'set', path: 'elements/it-i1', if_match: edited.sha256, data: { ...edited.data, text: '人工修改：搜索框优先' } }]);
    await boards.sync(snap(meeting(id, [...first, item('i3', '埋点', 'action', '小王对齐埋点口径', ['s2'])], { plan: plan('mindmap', { center: '首页改版' }) })));
    board = await boards.read(id);
    assert.equal(docOf(board, 'it-i1').data.text, '人工修改：搜索框优先', 'manual edit kept');
    assert.equal(docOf(board, 'it-i2').data.x, x1, 'viewpoints stay in their column');
    assert.equal(board.documents.filter(doc => doc.id.startsWith('mm-t-')).length, 2);
  } finally { await boards.close(); }
});


test('removing a topic node in the editor drops its lines and syncing carries on', async () => {
  const boards = new MeetingBoards(path.join(scratch, 'd' + n), assets); const id = fresh();
  try {
    const items = [item('i1', '首页改版', 'point', '搜索框放第一期', ['s0']), item('i2', '埋点', 'action', '小王对齐埋点口径', ['s2'])];
    const m = meeting(id, items, { plan: plan('mindmap', { center: '首页改版' }) });
    await boards.sync(snap(m));
    let board = await boards.read(id);
    const topic = board.documents.find(doc => doc.id.startsWith('mm-t-') && doc.data.text.includes('首页改版'));
    const lines = board.documents.filter(doc => doc.data.type === 'arrow' && (doc.data.from === topic.id || doc.data.to === topic.id));
    await boards.write(id, [...lines, topic].map(doc => ({ op: 'delete', path: 'elements/' + doc.id, if_match: doc.sha256 })));
    await boards.sync(snap({ ...m, items: [...items, item('i3', '埋点', 'decision', '埋点口径下周定稿', ['s3'])] }));
    board = await boards.read(id);
    assert.ok(!docOf(board, topic.id), 'removed topic stays removed');
    assert.ok(!board.documents.some(doc => doc.data.type === 'arrow' && (doc.data.from === topic.id || doc.data.to === topic.id)), 'no dangling lines');
    assert.ok(docOf(board, 'it-i3'), 'later viewpoints still arrive');
  } finally { await boards.close(); }
});

test('switching a topics board to a mind map never leaves dangling lines, even when the editor rewrote them or a person drew one', async () => {
  const boards = new MeetingBoards(path.join(scratch, 'd' + n), assets); const id = fresh();
  try {
    const items = [item('i1', '首页改版', 'proposal', '本期先做搜索框', ['s0']), item('i3', '首页改版', 'decision', '搜索框放第一期', ['s1']), item('i4', '数据埋点', 'question', '埋点口径待对齐', ['s4']),
      item('i6', '首页改版', 'point', '登录要少点几步', ['s2'], { sub: '登录体验' }), item('i7', '首页改版', 'risk', '免登可能有安全问题', ['s3'], { sub: '登录体验' })];
    const links = [{ id: 'i1-i4', from: 'i1', to: 'i4', type: 'opposes', label: '有分歧' }, { id: 'i3-i6', from: 'i3', to: 'i6', type: 'resolves', label: null }];
    const m = meeting(id, items, { links });
    await boards.sync(snap(m));
    let board = await boards.read(id);
    const block = board.documents.find(doc => doc.id.startsWith('blk-')); assert.ok(block, 'topics board has a subtopic block');
    const mine = board.documents.find(doc => doc.id.startsWith('it-')); assert.ok(mine, 'topics board has a card');
    assert.ok(board.documents.some(doc => doc.id.startsWith('ln-') && (doc.data.to === block.id || doc.data.from === block.id)), 'a relation ends on the block');
    // The editor rewrites lines and frames on its own (default fields, sub-pixel positions); a person also draws a line to the block.
    const rewrites = board.documents.filter(doc => doc.data.type === 'arrow' || doc.data.type === 'container')
      .map(doc => ({ op: 'set', path: 'elements/' + doc.id, if_match: doc.sha256, data: doc.data.type === 'arrow' ? { ...doc.data, dash: false } : { ...doc.data, y: doc.data.y + 0.25 } }));
    await boards.write(id, [...rewrites, { op: 'set', path: 'elements/user-line', if_match: null, data: { type: 'arrow', from: mine.id, to: block.id, color: 'ink', by: 'user' } }]);
    const card = docOf(await boards.read(id), mine.id);
    await boards.write(id, [{ op: 'set', path: 'elements/' + mine.id, if_match: card.sha256, data: { ...card.data, text: '我改过：搜索框先上' } }]);
    await boards.sync(snap({ ...m, plan: plan('mindmap', { center: '首页改版' }) }));
    board = await boards.read(id);
    const ids = new Set(board.documents.map(doc => doc.id));
    for (const doc of board.documents.filter(doc => doc.data.type === 'arrow')) assert.ok(ids.has(doc.data.from) && ids.has(doc.data.to), 'every line has both ends: ' + doc.id);
    assert.ok(!board.documents.some(doc => doc.id.startsWith('blk-') || doc.id.startsWith('ln-') || doc.id.startsWith('grp-')), 'topics structure is gone');
    assert.ok(docOf(board, 'mm-center') && board.documents.some(doc => doc.id.startsWith('mm-e-')), 'the mind map is drawn');
    assert.ok(!docOf(board, 'user-line'), 'a line whose end went away goes too');
    assert.equal(board.documents.find(doc => doc.data.text === '我改过：搜索框先上')?.id, mine.id, 'a person edit to a card is kept');
    await boards.sync(snap({ ...m, plan: plan('mindmap', { center: '首页改版' }), items: [...items, item('i8', '数据埋点', 'action', '小王对齐口径', ['s2'])] }));
    assert.ok(docOf(await boards.read(id), 'it-i8'), 'syncing carries on');
  } finally { await boards.close(); }
});
