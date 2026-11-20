import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {allowLocalBoardEmbedding,signalBoardReady} from '../scripts/board-embedding.mjs';
test('desktop embedding patch refuses unexpected vendor headers or editor structure',async()=>{
 const bundle=await readFile(new URL('../vendor/open-artifact.mjs',import.meta.url),'utf8');
 const header="frame-ancestors *; object-src 'none'";
 assert.throws(()=>allowLocalBoardEmbedding(bundle.replace(header,"frame-ancestors 'none'")),/changed/);
 assert.throws(()=>allowLocalBoardEmbedding(bundle+header),/changed/);
 assert.throws(()=>signalBoardReady('<html></html>'),/changed/);
 const html=await readFile(new URL('../vendor/assets/editors/whiteboard/index.html',import.meta.url),'utf8');
 assert.match(signalBoardReady(html),/data-testid="board-canvas"/);
});
