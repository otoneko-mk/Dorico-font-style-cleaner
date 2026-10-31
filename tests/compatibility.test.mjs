import test from 'node:test';
import assert from 'node:assert/strict';
import { DTN } from '../core/dtn.js';
import { Project } from '../core/project.js';
import { node, encodeTree, fixtureTrees, zipFixture } from './fixtures.mjs';

test('all 16 upper nibbles preserve each low-bit layout exactly', () => {
  for (let prefix = 0; prefix <= 0xf0; prefix += 0x10) {
    const bytes = encodeTree(
      node(
        'root',
        '',
        [
          node('a', '', [], prefix),
          node('b', '', [], prefix | 1),
          node('branch', '', [node('c')], prefix | 3),
        ],
        prefix | 2,
      ),
    );
    assert.deepEqual(new DTN(bytes).encode(), bytes);
  }
});
test('unrecognized layout bits fail with node, offset and marker', () => {
  for (let marker = 0; marker <= 0xff; marker++)
    if (marker & 0x0c) {
      assert.throws(
        () => new DTN(encodeTree(node('root', '', [], marker))),
        /node 0 \/ offset 0x[0-9a-f]+ \/ marker 0x/,
      );
    }
});
function fixture(version, prefix = 0xf0, mutate) {
  const trees = fixtureTrees();
  const visit = (tree) => {
    tree.marker = prefix | (tree.marker & 3);
    if (tree.tag === 'fileVersion') tree.value = version;
    tree.children.forEach(visit);
  };
  Object.values(trees).forEach(visit);
  mutate?.(trees);
  return zipFixture([
    { name: 'score.dtn', data: encodeTree(trees.score) },
    { name: 'scorelibrary.dtn', data: encodeTree(trees.library) },
  ]);
}
test('known and unseen version identifiers and marker prefixes support both merges', async () => {
  for (const version of [
    '1.1299',
    '1.1301',
    '1.1392',
    '1.1416',
    '1.1417',
    '1.1444',
    '1.1449',
    '1.1450',
    '1.1452',
    '1.9999',
    '2.0',
    'future-preview',
  ]) {
    for (const prefix of [0x10, 0x80, 0xe0, 0xf0]) {
      const bytes = fixture(version, prefix),
        project = await Project.open(bytes);
      assert.equal(project.fileVersion, version);
      assert.deepEqual(await project.exportBytes(), bytes);
      const merged = project
        .applyMerge(['font.A'], 'font.base')
        .applyMerge(['paragraph.B'], 'paragraph.A', 'paragraph');
      const saved = await Project.open(await merged.exportBytes());
      assert.equal(saved.stylesFor('font').size, 3);
      assert.equal(saved.stylesFor('paragraph').size, 3);
      assert.equal(saved.fileVersion, version);
      for (const doc of saved.docs.values())
        assert(doc.nodes.every((n) => (n.marker & 0xf0) === prefix));
    }
  }
});
test('future identifiers do not bypass unknown reference checks', async () => {
  const p = await Project.open(
    fixture('9.9999', 0x80, (trees) =>
      trees.score.children.push(node('unknownReference', 'font.A')),
    ),
  );
  assert.throws(() => p.applyMerge(['font.A'], 'font.base'), /未対応の参照/);
});
test('inconsistent, missing, empty and nested version fields are rejected', async () => {
  for (const mutate of [
    (t) => {
      t.library.children[0].value = 'other';
    },
    (t) => {
      t.library.children.shift();
    },
    (t) => {
      t.library.children[0].value = '';
    },
    (t) => {
      t.library.children[0] = node('fileVersion', '1.9999', [node('unknown')]);
    },
    (t) => {
      t.library.children.push(node('fileVersion', '1.9999'));
    },
  ])
    await assert.rejects(
      () => Project.open(fixture('1.9999', 0x80, mutate)),
      /内部バージョン/,
    );
});
test('compatible markers still require valid trees and byte-exact encoding', () => {
  const doc = new DTN(encodeTree(node('root', '', [node('leaf')], 0x82)));
  doc.nodes[0].children[0] = 999;
  assert.throws(() => new DTN(doc.encode()), /参照が範囲外/);
  const leaf = encodeTree(node('root', '', [], 0x80));
  assert.throws(() => new DTN(new Uint8Array([...leaf, 0])), /未解析データ/);
});
test('project parse errors identify the archive member', async () => {
  await assert.rejects(
    () => Project.open(fixture('1.1452', 0x84)),
    /score.dtn \/ 未対応のノード形式/,
  );
});
