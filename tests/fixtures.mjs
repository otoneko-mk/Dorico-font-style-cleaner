import { deflateRawSync } from 'node:zlib';
import { DTN } from '../core/dtn.js';
import { crc32, concat } from '../core/zip.js';

export const node = (tag, value = '', children = [], marker = children.length ? 0xc2 : 0xc0) => ({ tag, value, children, marker });
export function encodeTree(root) {
  const result = Object.create(DTN.prototype); result.tags = []; result.values = []; result.nodes = [];
  const index = (table, value) => { let i = table.indexOf(value); if (i < 0) { i = table.length; table.push(value); } return i; };
  const add = tree => {
    const i = result.nodes.length;
    const n = { marker: tree.marker, tag: index(result.tags, tree.tag), value: index(result.values, tree.value), children: [] };
    result.nodes.push(n); n.children = tree.children.map(add); return i;
  };
  add(root); return result.encode();
}
export function zipFixture(entries, comment = new Uint8Array([1, 2, 3])) {
  const local = [], central = []; let offset = 0;
  const set16 = (b, p, v) => new DataView(b.buffer).setUint16(p, v, true);
  const set32 = (b, p, v) => new DataView(b.buffer).setUint32(p, v, true);
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name), bytes = entry.data, method = entry.method ?? 8;
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(bytes)) : bytes;
    const flags = 0x800 | (entry.descriptor ? 8 : 0), crc = crc32(bytes), h = new Uint8Array(30);
    const size = entry.declaredSize ?? bytes.length;
    set32(h, 0, 0x04034b50); set16(h, 4, 20); set16(h, 6, flags); set16(h, 8, method);
    if (!entry.descriptor) { set32(h, 14, crc); set32(h, 18, compressed.length); set32(h, 22, size); }
    set16(h, 26, name.length);
    const descriptor = new Uint8Array(entry.descriptor ? 16 : 0);
    if (descriptor.length) { set32(descriptor, 0, 0x08074b50); set32(descriptor, 4, crc); set32(descriptor, 8, compressed.length); set32(descriptor, 12, size); }
    const data = concat([h, name, compressed, descriptor]); local.push(data);
    const c = new Uint8Array(46); set32(c, 0, 0x02014b50); set16(c, 4, 20); set16(c, 6, 20); set16(c, 8, flags); set16(c, 10, method);
    set32(c, 16, crc); set32(c, 20, compressed.length); set32(c, 24, size); set16(c, 28, name.length); set32(c, 38, 0x20); set32(c, 42, offset);
    central.push(concat([c, name])); offset += data.length;
  }
  const directory = concat(central), end = new Uint8Array(22);
  set32(end, 0, 0x06054b50); set16(end, 8, entries.length); set16(end, 10, entries.length); set32(end, 12, directory.length); set32(end, 16, offset); set16(end, 20, comment.length);
  return concat([...local, directory, end, comment]);
}
const field = node;
const font = (id, parent = '') => node('FontStyleEntityDefinition', '', [field('name', id), field('entityID', id), field('parentEntityID', parent), field('fontname', 'Example'), field('size', '11')]);
const paragraph = (id, parent = '') => node('ParagraphStyleEntityDefinition', '', [field('name', id), field('entityID', id), field('parentEntityID', parent), node('paragraphStyle', '', [field('fontname', 'Example'), node('borderPadding', '', [field('left', '0')])])]);
export function fixtureTrees() {
  const libraryChildren = () => [node('fileVersion', '1.1452'), node('fontstyles', '', [node('entities', '', [font('font.base'), font('font.A', 'font.base'), font('font.A1', 'font.A'), font('font.child', 'font.A1')], 0xc3)]),
  node('paragraphStyles', '', [node('entities', '', [paragraph('paragraph.base'), paragraph('paragraph.A', 'paragraph.base'), paragraph('paragraph.B', 'paragraph.A'), paragraph('paragraph.child', 'paragraph.B')])]),
  node('textDefinitions', '', [node('entities', '', [node('TextPrimitiveEntityDefinition', '', [field('name', 'm.font.A'), field('entityID', 'text.example'), field('fontStyle', 'font.A'), field('text', 'm')])])]),
  node('paragraph', '', [node('paragraphStyleID', 'paragraph.A')]), node('barNumberLayoutOptions', '', [node('barNumbersParagraphStyle', 'paragraph.B')])];
  return { score: node('kScore', '', [node('fileVersion', '1.1452'), node('library', '', libraryChildren())]), library: node('kScoreLibrary', '', libraryChildren()) };
}
export function projectFixture({ mutateScore, descriptor = true } = {}) {
  const trees = fixtureTrees(); if (mutateScore) mutateScore(trees.score);
  return zipFixture([{ name: 'score.dtn', data: encodeTree(trees.score), descriptor }, { name: 'scorelibrary.dtn', data: encodeTree(trees.library) },
  { name: 'supplementary_data/画像.bin', data: new Uint8Array([0, 128, 255, 12]), method: 0 }]);
}
