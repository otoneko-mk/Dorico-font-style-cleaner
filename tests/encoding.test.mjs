import test from 'node:test';
import assert from 'node:assert/strict';
import { DTN } from '../core/dtn.js';
import { node, encodeTree } from './fixtures.mjs';
test('invalid UTF-8 stays rejected and reports its dictionary entry and offset', () => {
  const bytes = encodeTree(node('root', 'bad-value'));
  const offset = Buffer.from(bytes).indexOf(Buffer.from('bad-value'));
  bytes[offset] = 0xb7;
  assert.throws(() => new DTN(bytes), /未対応の文字コードです：values\[0\] \/ offset 0x/);
});
