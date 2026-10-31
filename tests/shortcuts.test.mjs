import test from 'node:test';
import assert from 'node:assert/strict';
import { shortcutAction } from '../core/shortcuts.js';

const key = (value, options = {}) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  ...options,
});

test('file, search and merge commands support Control and Command', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    for (const [value, action] of [
      ['o', 'open'],
      ['s', 'save'],
      ['f', 'find'],
      ['Enter', 'merge'],
    ])
      assert.equal(shortcutAction(key(value, { [modifier]: true })), action);
    assert.equal(
      shortcutAction(key('S', { [modifier]: true, shiftKey: true })),
      'save',
    );
  }
});
test('undo, redo and selection use standard combinations', () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.equal(shortcutAction(key('z', { [modifier]: true })), 'undo');
    assert.equal(
      shortcutAction(key('Z', { [modifier]: true, shiftKey: true })),
      'redo',
    );
    assert.equal(shortcutAction(key('y', { [modifier]: true })), 'redo');
    assert.equal(shortcutAction(key('a', { [modifier]: true })), 'selectAll');
    assert.equal(
      shortcutAction(key('A', { [modifier]: true, shiftKey: true })),
      'clearSelection',
    );
  }
});
test('text editing shortcuts are left to editable fields', () => {
  for (const value of ['a', 'z', 'y'])
    assert.equal(
      shortcutAction(key(value, { ctrlKey: true }), { editable: true }),
      null,
    );
  assert.equal(
    shortcutAction(key('f', { ctrlKey: true }), { editable: true }),
    'find',
  );
});
test('IME composition, Alt combinations and browser navigation are not intercepted', () => {
  assert.equal(
    shortcutAction(key('o', { ctrlKey: true, isComposing: true })),
    null,
  );
  assert.equal(shortcutAction(key('o', { ctrlKey: true, altKey: true })), null);
  for (const value of ['r', 'l', 't', 'Tab', 'c', 'v', 'x'])
    assert.equal(shortcutAction(key(value, { ctrlKey: true })), null);
});
test('Escape clears search or list selection while preserving native selects', () => {
  assert.equal(shortcutAction(key('Escape')), 'clearSelection');
  assert.equal(
    shortcutAction(key('Escape'), { editable: true, search: true }),
    'clearSearch',
  );
  assert.equal(shortcutAction(key('Escape'), { select: true }), null);
});
