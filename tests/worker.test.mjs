import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { projectFixture } from './fixtures.mjs';
import { Project } from '../core/project.js';

test('worker commits validated revisions and retains state after a failed merge', async t => {
  const url = new URL('../worker.js', import.meta.url).href;
  const worker = new Worker(`
    const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:(...args)=>parentPort.postMessage(...args)};
    import(${JSON.stringify(url)}).then(()=>{
      parentPort.on('message',data=>self.onmessage({data}));
      parentPort.postMessage({ready:true});
    });
  `, { eval: true });
  t.after(() => worker.terminate());
  await once(worker, 'message');
  const call = async data => { const reply = once(worker,'message'); worker.postMessage(data); return (await reply)[0]; };
  const opened = await call({ id:1, action:'open', bytes:projectFixture().buffer });
  assert.equal(opened.ok,true); assert.equal(opened.result.catalogs.font.length,4);
  assert.equal((await Project.open(opened.result.bytes)).stylesFor('font').size,4);
  const merged = await call({ id:2, action:'merge', sources:['font.A'], target:'font.base', kind:'font' });
  assert.equal(merged.ok,true); assert.equal(merged.result.catalogs.font.length,3);
  const failed = await call({ id:3, action:'merge', sources:['paragraph.base'], target:'paragraph.child', kind:'paragraph' });
  assert.equal(failed.ok,false);
  const paragraph = await call({ id:4, action:'merge', sources:['paragraph.A','paragraph.B'], target:'paragraph.base', kind:'paragraph' });
  assert.equal(paragraph.ok,true); assert.equal(paragraph.result.catalogs.paragraph.length,2);
  const undone = await call({ id:6, action:'undo' });
  assert.equal(undone.ok,true); assert.equal(undone.result.catalogs.paragraph.length,4);
  assert.equal(undone.result.canRedo,true);
  const redone = await call({ id:7, action:'redo' });
  assert.equal(redone.ok,true); assert.equal(redone.result.catalogs.paragraph.length,2);
  assert.equal(redone.result.revision,paragraph.result.revision);
  const saved = await call({ id:5, action:'save' });
  assert.equal(saved.ok,true);
  const result = await Project.open(saved.result);
  assert.equal(result.stylesFor('font').size,3); assert.equal(result.stylesFor('paragraph').size,2);
});
