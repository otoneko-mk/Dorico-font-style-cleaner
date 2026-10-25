import test from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../core/project.js';
import { Session } from '../core/session.js';
import { projectFixture, fixtureTrees, encodeTree, zipFixture } from './fixtures.mjs';

async function session() { return new Session(await Project.open(projectFixture())); }

test('undo restores the exact original data and redo restores the merged revision', async () => {
  const s=await session(), initial=await s.initial();
  assert.equal(initial.canUndo,false); assert.equal(initial.revision,0);
  const merged=await s.merge(['font.A'],'font.base','font');
  assert.equal(merged.revision,1); assert.equal(merged.canUndo,true);
  const undone=await s.move('undo');
  assert.equal(undone.revision,0); assert.equal(undone.canUndo,false); assert.equal(undone.canRedo,true);
  assert.deepEqual(new Uint8Array(undone.bytes),new Uint8Array(initial.bytes));
  const redone=await s.move('redo');
  assert.equal(redone.revision,1); assert.deepEqual(new Uint8Array(redone.bytes),new Uint8Array(merged.bytes));
});
test('history spans font and paragraph operations', async () => {
  const s=await session();
  await s.merge(['font.A'],'font.base','font');
  const last=await s.merge(['paragraph.A','paragraph.B'],'paragraph.base','paragraph');
  await s.move('undo'); assert.equal(s.project.stylesFor('font').size,3); assert.equal(s.project.stylesFor('paragraph').size,4);
  await s.move('undo'); assert.equal(s.project.stylesFor('font').size,4);
  await s.move('redo'); const restored=await s.move('redo');
  assert.deepEqual(new Uint8Array(restored.bytes),new Uint8Array(last.bytes));
});
test('a new merge after undo invalidates redo and has a distinct revision ID', async () => {
  const s=await session();
  await s.merge(['font.A'],'font.base','font');
  await s.merge(['paragraph.B'],'paragraph.A','paragraph');
  await s.move('undo');
  const branch=await s.merge(['font.A1'],'font.base','font');
  assert.equal(branch.revision,3); assert.equal(branch.canRedo,false);
  await assert.rejects(()=>s.move('redo'));
});
test('invalid merges and export failures do not alter history or current data', async () => {
  const s=await session(); await s.merge(['font.A'],'font.base','font');
  const original=s.project, past=s.past.slice();
  await assert.rejects(()=>s.merge(['paragraph.base'],'paragraph.child','paragraph'));
  assert.strictEqual(s.project,original); assert.deepEqual(s.past,past);
  const exportBytes=Project.prototype.exportBytes;
  try {
    Project.prototype.exportBytes=async()=>{throw new Error('export failed');};
    await assert.rejects(()=>s.merge(['paragraph.B'],'paragraph.A','paragraph'));
  } finally { Project.prototype.exportBytes=exportBytes; }
  assert.strictEqual(s.project,original); assert.deepEqual(s.past,past); assert.equal(s.revision,1);
});
test('undo history has a bounded step count', async () => {
  const trees=fixtureTrees();
  for (const tree of [trees.score.children[1],trees.library]) {
    const entities=tree.children.find(n=>n.tag==='fontstyles').children[0];
    const template=entities.children[1];
    for(let i=0;i<35;i++) {
      const next=structuredClone(template);
      for(const field of next.children) if(['entityID','name'].includes(field.tag)) field.value=`font.history.${i}`;
      entities.children.push(next);
    }
  }
  const bytes=zipFixture([{name:'score.dtn',data:encodeTree(trees.score)},{name:'scorelibrary.dtn',data:encodeTree(trees.library)}]);
  const s=new Session(await Project.open(bytes));
  for(let i=0;i<35;i++) await s.merge([`font.history.${i}`],'font.base','font');
  assert.equal(s.past.length,32);
  for(let i=0;i<32;i++) await s.move('undo');
  assert.equal(s.revision,3); await assert.rejects(()=>s.move('undo'));
});
