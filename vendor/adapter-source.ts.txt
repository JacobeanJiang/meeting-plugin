import { createTypeServer } from '@open-artifact/type-server';
import { DbStore } from '@open-artifact/server-sdk/db';
import { scaffoldWhiteboard, checkWhiteboard } from '@open-artifact/type-server/src/whiteboard.ts';
import { agentPaths } from '@open-artifact/type-server/src/agent.ts';
import { mkdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** This narrow adapter is owned by the meeting plugin; upstream models remain unchanged. */
export async function startBoardEngine(assetsDir: string): Promise<{
  open: (root: string, title: string) => Promise<string>;
  read: (root: string, path: string) => unknown;
  write: (root: string, writes: unknown[]) => unknown;
  context: (root: string) => Promise<unknown>;
  stop: () => Promise<void>;
}> {
  const server = createTypeServer({ assetsDir, types:['whiteboard'], secret:randomBytes(32).toString('hex'), idleMs:0, daemon:null, viewerName:'会议记录', log:()=>undefined, lanAddresses:()=>[] });
  await server.listen(0,'127.0.0.1');
  const stores = new Map<string,DbStore>();
  const store = (root: string): DbStore => { let s=stores.get(root);if(!s){s=new DbStore(root);stores.set(root,s);}return s; };
  return {
    async open(root,title){
      await mkdir(root,{recursive:true,mode:0o700});
      const existing=store(root).readDb('board/meta') as {exists:boolean};
      if(!existing.exists) store(root).writeDb(Object.entries(scaffoldWhiteboard(title)).map(([path,raw])=>({op:'set',path:path.replace(/\.json$/,''),data:JSON.parse(raw),if_match:null})));
      return (await server.open({root,title,type:'whiteboard'})).url;
    },
    read(root,path){return store(root).readDb(path);},
    write(root,writes){
      // Validate the proposed final board before committing any document.
      const docs=new Map<string,string>();
      for(const doc of store(root).listAll()){const value=store(root).readDb(doc.path) as {data:unknown};docs.set(doc.path,JSON.stringify(value.data));}
      for(const raw of writes){const w=raw as {op:string;path:string;data:unknown};if(w.op==='delete')docs.delete(w.path);else if(w.op==='set')docs.set(w.path,JSON.stringify(w.data));else throw Error('Meeting adapter only accepts guarded set/delete operations');}
      const errors=checkWhiteboard(docs).filter(f=>f.level==='error');
      if(errors.length)throw Error('Invalid whiteboard: '+errors[0].message);
      return store(root).writeDb(writes,{requireIfMatch:true});
    },
    async context(root){try {return JSON.parse(await readFile(agentPaths(root).viewContext,'utf8'));}catch{return null;}},
    stop:()=>server.stop(),
  };
}
