import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DTN, FormatError } from '../core/dtn.js';
import { Project } from '../core/project.js';
import { ZipArchive } from '../core/zip.js';

const requireValue = (condition, message) => { if (!condition) throw new FormatError(message); };
const string = v => typeof v === 'string' && !v.includes('\0') && new TextDecoder().decode(new TextEncoder().encode(v)) === v;

export function decode(bytes) {
  const doc = new DTN(bytes);
  return {
    format: 'dorico-dtn-json-1', tags: doc.tags, values: doc.values,
    nodes: doc.nodes.map((n, id) => ({
      id, marker: `0x${n.marker.toString(16).padStart(2, '0')}`,
      tag: doc.tag(id), value: doc.value(id), children: n.children,
      tagIndex: n.tag, valueIndex: n.value
    }))
  };
}
export function encode(json) {
  requireValue(json?.format === 'dorico-dtn-json-1', '未対応のJSON形式です。');
  const doc = Object.create(DTN.prototype);
  for (const key of ['tags', 'values']) {
    requireValue(Array.isArray(json[key]) && json[key].length <= 2_000_000 && json[key].every(string), `${key}辞書が不正です。`);
    doc[key] = json[key].slice();
  }
  requireValue(Array.isArray(json.nodes) && json.nodes.length > 0 && json.nodes.length <= 2_000_000, 'ノード一覧が不正です。');
  const ids = new Map();
  json.nodes.forEach((n, i) => {
    requireValue(n && Number.isInteger(n.id) && n.id >= 0 && n.id <= 0xffffffff && !ids.has(n.id), `ノードIDが不正または重複しています：${i}`);
    ids.set(n.id, i);
  });
  requireValue(json.nodes[0].id === 0, '先頭はルートノード（id: 0）にしてください。');
  const indices = Object.fromEntries(['tags', 'values'].map(key => {
    const map = new Map(); doc[key].forEach((v, i) => { if (!map.has(v)) map.set(v, i); }); return [key, map];
  }));
  const intern = (key, value, hint) => {
    if (Number.isInteger(hint) && hint >= 0 && doc[key][hint] === value) return hint;
    if (indices[key].has(value)) return indices[key].get(value);
    const i = doc[key].length; doc[key].push(value); indices[key].set(value, i); return i;
  };
  doc.nodes = json.nodes.map(n => {
    requireValue(typeof n.marker === 'string' && /^0x[0-9a-f]{2}$/i.test(n.marker), `markerが不正です：node ${n.id}`);
    requireValue(string(n.tag) && string(n.value), `tag/valueが不正です：node ${n.id}`);
    requireValue(Array.isArray(n.children) && n.children.every(c => Number.isInteger(c) && ids.has(c)), `子ノードの参照が不正です：node ${n.id}`);
    const marker = Number(n.marker);
    requireValue((marker & 2) || !n.children.length, `子ノードを持てないmarkerです：node ${n.id}`);
    return { marker, tag: intern('tags', n.tag, n.tagIndex), value: intern('values', n.value, n.valueIndex), children: n.children.map(c => ids.get(c)) };
  });
  doc.validate(); const bytes = doc.encode(); new DTN(bytes); return bytes;
}

async function main() {
  const [command, input, output, ...options] = process.argv.slice(2);
  requireValue(input && output, 'decode INPUT OUTPUT.json [MEMBER]\nencode INPUT.json OUTPUT.dtn\nreplace INPUT.dorico OUTPUT.dorico MEMBER=FILE.dtn [...]');
  let result;
  if (command === 'decode') {
    let bytes = new Uint8Array(await readFile(input));
    requireValue(options.length <= 1, 'MEMBERは1つ指定してください。');
    if (options.length) {
      const data = await new ZipArchive(bytes).unpack();
      requireValue(data.has(options[0]), '指定されたZIP項目がありません。'); bytes = data.get(options[0]);
    }
    result = JSON.stringify(decode(bytes), null, 2) + '\n';
  } else if (command === 'encode') {
    requireValue(!options.length, '余分な引数があります。');
    result = encode(JSON.parse(await readFile(input, 'utf8')));
  } else if (command === 'replace') {
    requireValue(options.length > 0, 'MEMBER=FILE.dtnを指定してください。');
    const archive = new ZipArchive(new Uint8Array(await readFile(input))), data = await archive.unpack(), seen = new Set();
    for (const option of options) {
      const split = option.indexOf('='), member = option.slice(0, split);
      requireValue(split > 0 && member.endsWith('.dtn') && data.has(member) && !seen.has(member), '置換するZIP項目が不正または重複しています。');
      const bytes = new Uint8Array(await readFile(option.slice(split + 1))); new DTN(bytes);
      data.set(member, bytes); seen.add(member);
    }
    result = archive.write(data);
    const verified = await Project.open(result); await verified.exportBytes();
  } else throw new FormatError('コマンドはdecode / encode / replaceから選んでください。');
  await writeFile(output, result, { flag: 'wx' }); console.log(output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
