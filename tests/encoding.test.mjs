import test from 'node:test';
import assert from 'node:assert/strict';
import { DTN, decodeValue, encodeValue, hasByteEscapes } from '../core/dtn.js';
import { Project } from '../core/project.js';
import { decode, encode } from '../tools/dtn-json.mjs';
import { node, encodeTree, fixtureTrees, zipFixture } from './fixtures.mjs';

function invalidFixture() {
  const bytes = encodeTree(node('root', '', [node('value', 'bad-value'), node('other', 'bad-value')]));
  bytes[Buffer.from(bytes).indexOf(Buffer.from('bad-value'))] = 0xb7;
  return bytes;
}

test('non-UTF8 values round-trip through DTN and serialized JSON without replacement', () => {
  const bytes = invalidFixture(), doc = new DTN(bytes);
  assert(hasByteEscapes(doc.value(1))); assert(!doc.value(1).includes('\ufffd'));
  assert.deepEqual(doc.encode(), bytes);
  const json = JSON.stringify(decode(bytes)); assert(json.includes('\\udcb7'));
  assert.deepEqual(encode(JSON.parse(json)), bytes);
});
test('editing a shared opaque value changes only the selected node', () => {
  const bytes = invalidFixture(), json = decode(bytes); json.nodes[1].value = '編集後';
  const doc = new DTN(encode(json));
  assert.equal(doc.value(1), '編集後');
  assert.equal(doc.value(2), new DTN(bytes).value(2));
});
test('byte escapes are reversible and distinct across malformed UTF8 sequences', () => {
  const samples = [[0x80], [0x81], [0xc0,0xaf], [0xed,0xa0,0x80], [0xf4,0x90,0x80,0x80], [0xe6,0x97,0xa5,0x80], [0xff,0xfe]];
  const texts = samples.map(a=>decodeValue(new Uint8Array(a)));
  assert.equal(new Set(texts).size, samples.length);
  samples.forEach((a,i)=>assert.deepEqual(encodeValue(texts[i]),new Uint8Array(a)));
  for(const text of ['日本語', '𝄞', String.fromCodePoint(0x10080), '\ufffd', '\ufeffBOM']) {
    assert(!hasByteEscapes(text)); assert.equal(decodeValue(encodeValue(text)), text);
  }
  for(const text of ['\ud800','\udc00','\udc7f','\udd00','bad\0value']) assert.throws(()=>encodeValue(text));
});
test('malformed tag names remain rejected', () => {
  const bytes = encodeTree(node('root'));
  bytes[Buffer.from(bytes).indexOf(Buffer.from('root'))] = 0xb7;
  assert.throws(()=>new DTN(bytes), /未対応の文字コードです：tags\[0\]/);
});
function project(unknown = false) {
  const trees = fixtureTrees(), id = 'font.日本語';
  const visit = n => {n.value = n.value.replaceAll('font.A', id); n.children.forEach(visit);};
  Object.values(trees).forEach(visit);
  const raw = new Uint8Array([...new TextEncoder().encode(`opaque:${id}:`), 0x80]);
  trees.score.children.push(node(unknown ? 'unknown' : 'lineStyleEntityID', decodeValue(raw)));
  if(!unknown) trees.score.children.at(-1).value = decodeValue(new Uint8Array([0x80,0x81]));
  return zipFixture([{name:'score.dtn',data:encodeTree(trees.score)},{name:'scorelibrary.dtn',data:encodeTree(trees.library)}]);
}
test('opaque unrelated IDs survive merging, cloning and saved reload', async () => {
  const p=await Project.open(project()), q=p.applyMerge(['font.日本語'],'font.base');
  const saved = await Project.open(await q.exportBytes());
  for(const doc of [p.docs.get('score.dtn'),saved.docs.get('score.dtn')]) {
    const i=doc.nodes.findIndex((n,i)=>doc.tag(i)==='lineStyleEntityID');
    assert.deepEqual(encodeValue(doc.value(i)),new Uint8Array([0x80,0x81]));
  }
});
test('unknown raw references containing a Unicode style ID are still rejected', async () => {
  const p=await Project.open(project(true));
  assert.throws(()=>p.applyMerge(['font.日本語'],'font.base'), /未対応の参照/);
});
test('opaque style IDs remain distinct and are detected in non-DTN entries', async () => {
  const id = 'font.\udc80', trees = fixtureTrees();
  const visit = n => {n.value = n.value.replaceAll('font.A', id); n.children.forEach(visit);};
  Object.values(trees).forEach(visit);
  const entries = [{name:'score.dtn',data:encodeTree(trees.score)}, {name:'scorelibrary.dtn',data:encodeTree(trees.library)}];
  const p = await Project.open(zipFixture(entries));
  const saved = await Project.open(await p.applyMerge([id], 'font.base').exportBytes());
  assert(!saved.stylesFor('font').has(id)); assert(p.stylesFor('font').has(id));
  entries.push({name:'unknown.bin',data:encodeValue(`prefix ${id} suffix`)});
  const external = await Project.open(zipFixture(entries));
  assert.throws(()=>external.applyMerge([id], 'font.base'), /DTN以外に参照/);
});
