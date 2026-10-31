import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from '../tools/dtn-json.mjs';
import { node, encodeTree } from './fixtures.mjs';
import { DTN } from '../core/dtn.js';

test('editable JSON preserves duplicate dictionary entries and original indices', () => {
  const d = new DTN(
    encodeTree(
      node('root', '', [node('name', 'same'), node('name', 'same')], 0xf2),
    ),
  );
  d.values.push('same');
  d.nodes[2].value = d.values.length - 1;
  const bytes = d.encode();
  assert.deepEqual(encode(decode(bytes)), bytes);
  const json = decode(bytes);
  json.nodes[1].value = '変更';
  const edited = new DTN(encode(json));
  assert.equal(edited.value(1), '変更');
  assert.equal(edited.value(2), 'same');
});
test('JSON rejects invalid references, duplicate IDs and children on leaves', () => {
  const fixture = () => decode(encodeTree(node('root', '', [node('child')])));
  const dangling = fixture();
  dangling.nodes[0].children = [99];
  assert.throws(() => encode(dangling));
  const duplicate = fixture();
  duplicate.nodes[1].id = 0;
  assert.throws(() => encode(duplicate));
  const leaf = fixture();
  leaf.nodes[0].marker = '0xf0';
  assert.throws(() => encode(leaf));
  const orphan = fixture();
  orphan.nodes[0].children = [];
  assert.throws(() => encode(orphan));
});
