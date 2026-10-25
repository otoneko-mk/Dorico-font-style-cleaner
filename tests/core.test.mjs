import test from 'node:test';
import assert from 'node:assert/strict';
import { DTN } from '../core/dtn.js';
import { ZipArchive, crc32 } from '../core/zip.js';
import { Project } from '../core/project.js';
import { node, encodeTree, zipFixture, projectFixture } from './fixtures.mjs';

const values = doc => doc.nodes.map((n, i) => [doc.tag(i), doc.value(i)]);

test('DTN round-trip preserves UTF-8, all node markers and dictionaries', () => {
  const bytes = encodeTree(node('root', '', [node('name', '日本語', [], 0xc1), node('branch', '', [node('value', 'ok')], 0xc3)]));
  assert.deepEqual(new DTN(bytes).encode(), bytes);
});
test('DTN rejects truncated data and unsupported headers', () => {
  const bytes = encodeTree(node('root', '', [node('child')]));
  assert.throws(() => new DTN(bytes.slice(0, -1)));
  const wrong = bytes.slice(); wrong[0] = 3; assert.throws(() => new DTN(wrong));
});
test('DTN rejects dangling and cyclic node references', () => {
  const d = new DTN(encodeTree(node('root', '', [node('child')])));
  d.nodes[0].children[0] = 99; assert.throws(() => d.validate());
  d.nodes[0].children[0] = 0; assert.throws(() => d.validate());
});
test('ZIP reads stored and deflated members, UTF-8 names and descriptors', async () => {
  const archive = new ZipArchive(projectFixture());
  const data = await archive.unpack(); assert.equal(data.size, 3);
  assert.deepEqual(data.get('supplementary_data/画像.bin'), new Uint8Array([0, 128, 255, 12]));
});
test('ZIP refuses duplicate members', () => {
  assert.throws(() => new ZipArchive(zipFixture([{ name: 'x', data: new Uint8Array() }, { name: 'x', data: new Uint8Array() }])));
});
test('ZIP refuses corrupted CRC data', async () => {
  const bytes = zipFixture([{ name: 'x', data: new Uint8Array([1, 2, 3]), method: 0 }]);
  bytes[31] ^= 1;
  await assert.rejects(async () => new ZipArchive(bytes).unpack());
});
test('ZIP bounds the decompressed stream by declared size', async () => {
  const bytes = zipFixture([{ name: 'x', data: new Uint8Array(10000), declaredSize: 2 }]);
  await assert.rejects(async () => new ZipArchive(bytes).unpack(), /サイズ/);
});
test('CRC32 matches the standard check value', () => assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926));
test('an unchanged project exports identically, including ZIP metadata', async () => {
  const bytes = projectFixture(); const p = await Project.open(bytes);
  assert.deepEqual(await p.exportBytes(), bytes);
});
test('font batch removes only selected definitions and redirects remaining children', async () => {
  const p = await Project.open(projectFixture()), q = p.applyMerge(['font.A', 'font.A1'], 'font.base');
  assert.equal(p.stylesFor('font').size, 4); assert.equal(q.stylesFor('font').size, 2);
  assert.equal(q.stylesFor('font').get('font.child').parentEntityID, 'font.base');
  for (const doc of q.docs.values()) {
    assert(values(doc).some(([tag, value]) => tag === 'name' && value === 'm.font.A'));
    assert(!values(doc).some(([tag, value]) => tag === 'fontStyle' && value === 'font.A'));
  }
});
test('paragraph batch handles text, bar-number and parent references', async () => {
  const p = await Project.open(projectFixture()), q = p.applyMerge(['paragraph.A', 'paragraph.B'], 'paragraph.base', 'paragraph');
  assert.equal(q.stylesFor('paragraph').size, 2);
  assert.equal(q.stylesFor('paragraph').get('paragraph.child').parentEntityID, 'paragraph.base');
  for (const doc of q.docs.values()) {
    assert(values(doc).some(([tag, value]) => tag === 'paragraphStyleID' && value === 'paragraph.base'));
    assert(values(doc).some(([tag, value]) => tag === 'barNumbersParagraphStyle' && value === 'paragraph.base'));
  }
});
test('multiple font and paragraph operations accumulate before export', async () => {
  const p = await Project.open(projectFixture());
  const q = p.applyMerge(['font.A1'], 'font.A').applyMerge(['paragraph.B'], 'paragraph.A', 'paragraph').applyMerge(['font.A'], 'font.base');
  const saved = await Project.open(await q.exportBytes());
  assert.equal(saved.stylesFor('font').size, 2); assert.equal(saved.stylesFor('paragraph').size, 3);
  assert.equal(p.stylesFor('font').size, 4); assert.equal(p.stylesFor('paragraph').size, 4);
  assert.deepEqual(saved.data, q.data);
});
test('unchanged ZIP members and comments remain unchanged after merging', async () => {
  const p = await Project.open(projectFixture()), saved = await Project.open(await p.applyMerge(['font.A'], 'font.base').exportBytes());
  const name = 'supplementary_data/画像.bin';
  assert.deepEqual(saved.archive.byName.get(name).localRaw, p.archive.byName.get(name).localRaw);
  assert.deepEqual(saved.archive.comment, p.archive.comment);
});
test('empty selections, mixed kinds and inheritance cycles are rejected', async () => {
  const p = await Project.open(projectFixture());
  for (const [sources, target, kind] of [[[], 'font.base', 'font'], [['font.base'], 'font.A', 'font'], [['font.A'], 'font.A', 'font'], [['font.A'], 'paragraph.base', 'paragraph']]) assert.throws(() => p.applyMerge(sources, target, kind));
});
test('unknown references fail without changing the current revision', async () => {
  const p = await Project.open(projectFixture({ mutateScore: tree => tree.children.push(node('unknown', 'font.A')) }));
  const original = p.data.get('score.dtn').slice();
  assert.throws(() => p.applyMerge(['font.A'], 'font.base'), /未対応の参照/);
  assert.deepEqual(p.data.get('score.dtn'), original);
});
test('a name outside a text primitive is not silently ignored', async () => {
  const p = await Project.open(projectFixture({ mutateScore: tree => tree.children.push(node('name', 'm.font.A')) }));
  assert.throws(() => p.applyMerge(['font.A'], 'font.base'), /未対応の参照/);
});
test('nested paragraph differences between DTNs are rejected', async () => {
  const bytes = projectFixture({
    mutateScore: tree => {
      const visit = n => { if (n.tag === 'fontname' && n.value === 'Example') n.value = 'Changed'; n.children.forEach(visit); };
      const paragraphStyles = tree.children[1].children.find(n => n.tag === 'paragraphStyles'); visit(paragraphStyles);
    }
  });
  await assert.rejects(() => Project.open(bytes), /定義が一致/);
});
