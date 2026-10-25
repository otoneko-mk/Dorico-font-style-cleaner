import test from 'node:test';
import assert from 'node:assert/strict';
import { DTN } from '../core/dtn.js';
import { Project, SUPPORTED_VERSIONS } from '../core/project.js';
import { node, encodeTree, fixtureTrees, zipFixture } from './fixtures.mjs';

test('observed marker prefixes preserve all four low-bit variants exactly', () => {
  for (const prefix of [0x00, 0x30, 0x40, 0x60, 0xc0, 0xd0, 0xf0]) {
    const bytes = encodeTree(node('root', '', [node('a', '', [], prefix), node('b', '', [], prefix | 1), node('branch', '', [node('c')], prefix | 3)], prefix | 2));
    assert.deepEqual(new DTN(bytes).encode(), bytes);
  }
});
test('unknown prefixes and low bits fail with node, offset and marker', () => {
  for (const marker of [0x12, 0x82, 0xc4, 0xcc, 0xff]) {
    assert.throws(() => new DTN(encodeTree(node('root', '', [], marker))), /node 0 \/ offset 0x[0-9a-f]+ \/ marker 0x/);
  }
});
function fixture(version, prefix = 0xf0) {
  const trees = fixtureTrees();
  const visit = tree => {
    tree.marker = prefix | (tree.marker & 3);
    if (tree.tag === 'fileVersion') tree.value = version;
    tree.children.forEach(visit);
  };
  Object.values(trees).forEach(visit);
  return zipFixture([{ name: 'score.dtn', data: encodeTree(trees.score) }, { name: 'scorelibrary.dtn', data: encodeTree(trees.library) }]);
}
test('observed versions support font and paragraph merges and saved reload', async () => {
  for (const version of SUPPORTED_VERSIONS) {
    const bytes = fixture(version), project = await Project.open(bytes);
    assert.deepEqual(await project.exportBytes(), bytes);
    const merged = project.applyMerge(['font.A'], 'font.base').applyMerge(['paragraph.B'], 'paragraph.A', 'paragraph');
    const saved = await Project.open(await merged.exportBytes());
    assert.equal(saved.stylesFor('font').size, 3);
    assert.equal(saved.stylesFor('paragraph').size, 3);
    for (const doc of saved.docs.values()) assert(doc.nodes.every(n => (n.marker & 0xf0) === 0xf0));
  }
});
test('unobserved versions are still rejected', async () => {
  await assert.rejects(() => Project.open(fixture('1.9999')), /未対応の内部バージョン/);
});
test('project parse errors identify the archive member', async () => {
  await assert.rejects(() => Project.open(fixture('1.1452', 0x80)), /score.dtn \/ 未対応のノード形式/);
});
