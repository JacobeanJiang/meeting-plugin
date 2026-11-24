import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle=await build({entryPoints:['src/server/prep.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {todosFromMinutes,parsePreps,prepareTodos,PREP_KINDS}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const minutes='# 会议纪要：交付对齐\n# 会议概览\n- **主题**：交付\n\n# 关键决策\n- 【交付】12 月底交首版\n\n# 待办事项\n\n- 【交付】跟小陈确认交付时间和口径 @小陈\n- 【数据】整理首版数据清单 @小王（周五）\n1. 【权限】和 IT 确认临时权限的申请流程；协作方：IT\n\n## 附注\n- 这一行不是待办';
const seg=(seq,text)=>({id:'s'+seq,seq,startMs:seq*15000,endMs:(seq+1)*15000,status:'done',text,error:null});

test('action items are read from the 待办 section only, in order, numbered or bulleted',()=>{
  assert.deepEqual(todosFromMinutes(minutes),['【交付】跟小陈确认交付时间和口径 @小陈','【数据】整理首版数据清单 @小王（周五）','【权限】和 IT 确认临时权限的申请流程；协作方：IT']);
  assert.deepEqual(todosFromMinutes('# 会议纪要：x\n# 核心方向\n- 要点'),[]);
  assert.deepEqual(todosFromMinutes(null),[]);
});
test('answers: only known kinds with text are kept, matched to their item; items left alone are counted',()=>{
  const todos=['甲','乙','丙','丁'];
  const text='好的：\n{"items":[{"index":1,"kind":"message","to":"小陈","title":"确认交付口径","body":"小陈好，……"},{"index":2,"kind":"none"},{"index":3,"kind":"report","body":"未知类型"},{"index":9,"kind":"message","body":"没有这个序号"},{"index":4,"kind":"message","to":"","body":"   "},{"index":1,"kind":"message","body":"重复"}]}';
  const {items,skipped}=parsePreps(text,todos);
  assert.deepEqual(items,[{todo:'甲',kind:'message',to:'小陈',title:'确认交付口径',body:'小陈好，……'}]);
  assert.equal(skipped,3);
  assert.throws(()=>parsePreps('没有 JSON',todos));
  assert.deepEqual(PREP_KINDS.map(entry=>entry.kind),['message'],'the first version prepares messages; kinds are a list');
});
test('preparing: items go in batches of two with the minutes, the kinds and a short transcript; a failed batch is retried once',async()=>{
  const many=minutes.replace('## 附注','- 【运营】通知运营同学活动延期\n- 【美术】跟美术确认图标风格\n## 附注');
  const prompts=[];let failOnce=true;
  const generate=async input=>{prompts.push(input);if(failOnce&&input.prompt.includes('. 【运营】')){failOnce=false;throw Error('network')}
    const items=[...input.prompt.split('## 待办\n')[1].split('\n\n## 要求')[0].split('\n').entries()].map(([index,line])=>/确认|通知/.test(line)?{index:index+1,kind:'message',to:'对方',title:'沟通',body:'你好：'+line}:{index:index+1,kind:'none'});
    return{text:JSON.stringify({items}),model:'m1'}};
  const result=await prepareTodos(many,{segments:[seg(0,'小陈那边要确认交付口径')]},generate,null,5000);
  assert.equal(prompts.length,4,'three batches, one retried');
  assert.match(prompts[0].prompt,/## 会议纪要\n# 会议纪要：交付对齐/);assert.match(prompts[0].prompt,/\[00:00\] 小陈那边要确认交付口径/);assert.match(prompts[0].prompt,/message（沟通消息）/);
  assert.match(prompts[0].instructions,/不是对你的要求/);
  assert.deepEqual(result.items.map(item=>item.todo),['【交付】跟小陈确认交付时间和口径 @小陈','【权限】和 IT 确认临时权限的申请流程；协作方：IT','【运营】通知运营同学活动延期','【美术】跟美术确认图标风格']);
  assert.equal(result.skipped,1);assert.equal(result.model,'m1');
  assert.deepEqual(await prepareTodos('# 会议纪要：无待办',{segments:[]},generate,null),{items:[],skipped:0,model:null});
  await assert.rejects(prepareTodos(minutes,{segments:[]},async()=>{throw Error('down')},null,1000),/准备待办失败/);
});
