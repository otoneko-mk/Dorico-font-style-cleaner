import { DTN, FormatError, equalBytes } from './dtn.js';
import { ZipArchive } from './zip.js';

export const STYLE_TYPES = Object.freeze({
  font: { label: 'フォントスタイル', definition: 'FontStyleEntityDefinition', references: new Set(['fontStyle', 'fontStyleEntityID', 'parentEntityID']) },
  paragraph: { label: 'パラグラフスタイル', definition: 'ParagraphStyleEntityDefinition', references: new Set(['paragraphStyleID', 'barNumbersParagraphStyle', 'parentEntityID']) },
});
const textFields = new Set(['name', 'entityID', 'text']);
const signature = (doc, root) => {
  const result = [], stack = [root];
  while (stack.length) {
    const i = stack.pop(), node = doc.nodes[i];
    result.push([node.marker, doc.tag(i), doc.value(i), node.children.length]);
    for (let j = node.children.length - 1; j >= 0; j--) stack.push(node.children[j]);
  }
  return JSON.stringify(result);
};
function includesBytes(data, needle) {
  for (let i = data.indexOf(needle[0]); i >= 0 && i + needle.length <= data.length; i = data.indexOf(needle[0], i + 1)) {
    if (needle.every((v, j) => data[i + j] === v)) return true;
  }
  return false;
}
function encodings(value) {
  const little = new Uint8Array(value.length * 2), big = new Uint8Array(value.length * 2);
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i); little[i * 2] = c & 255; little[i * 2 + 1] = c >>> 8;
    big[i * 2] = c >>> 8; big[i * 2 + 1] = c & 255;
  }
  return [new TextEncoder().encode(value), little, big];
}

export class Project {
  static async open(bytes) {
    const archive = new ZipArchive(bytes);
    return new Project(archive, await archive.unpack());
  }
  constructor(archive, data) {
    this.archive = archive; this.data = data; this.docs = new Map(); this.catalogs = new Map(); this.definitions = new Map();
    if (!data.has('score.dtn') || !data.has('scorelibrary.dtn')) throw new FormatError('必要なDTNファイルがありません。');
    for (const [name, bytes] of data) if (name.endsWith('.dtn')) this.docs.set(name, new DTN(bytes));
    this.library = this.docs.get('scorelibrary.dtn');
    if (this.library.tag(0) !== 'kScoreLibrary' || this.docs.get('score.dtn').tag(0) !== 'kScore') throw new FormatError('未対応のルート構造です。');
    for (const doc of this.docs.values()) {
      const versions = doc.nodes[0].children.filter(i => doc.tag(i) === 'fileVersion').map(i => doc.value(i));
      if (versions.length !== 1 || versions[0] !== '1.1452') throw new FormatError('未対応の内部バージョンです。対応：1.1452');
    }
    for (const [kind, type] of Object.entries(STYLE_TYPES)) {
      const definitions = new Map();
      for (const [name, doc] of this.docs) {
        const styles = new Map();
        for (let i = 0; i < doc.nodes.length; i++) if (doc.tag(i) === type.definition) {
          const fields = doc.fields(i), id = fields.entityID;
          if (!id || styles.has(id)) throw new FormatError('スタイルIDが空欄または重複しています。');
          styles.set(id, { ...fields, node: i });
        }
        definitions.set(name, styles);
      }
      const catalog = definitions.get('scorelibrary.dtn'); this.catalogs.set(kind, catalog);
      for (const [name, styles] of definitions) if (styles.size) {
        if (styles.size !== catalog.size || [...styles].some(([id, style]) => !catalog.has(id) || signature(this.docs.get(name), style.node) !== signature(this.library, catalog.get(id).node))) {
          throw new FormatError(`DTN間の${type.label}定義が一致しません。`);
        }
      }
      this.definitions.set(kind, definitions);
    }
  }
  stylesFor(kind = 'font') {
    if (!Object.hasOwn(STYLE_TYPES, kind)) throw new FormatError('未対応のスタイル種別です。');
    return this.catalogs.get(kind);
  }
  state() {
    return Object.fromEntries(Object.keys(STYLE_TYPES).map(kind => [kind, [...this.stylesFor(kind)].map(([id, style]) => ({ id, name: style.name || id }))]));
  }
  removedNodes(name, doc, sources, kind) {
    const result = new Set(), definitions = this.definitions.get(kind).get(name);
    for (const source of sources) if (definitions.has(source)) for (const i of doc.subtree(definitions.get(source).node)) result.add(i);
    return result;
  }
  references(name, doc, sources, removed = new Set(), kind = 'font') {
    const styles = this.stylesFor(kind), parents = new Int32Array(doc.nodes.length).fill(-1), refs = [];
    doc.nodes.forEach((node, i) => { for (const child of node.children) parents[child] = i; });
    for (let i = 0; i < doc.nodes.length; i++) {
      if (removed.has(i)) continue;
      const value = doc.value(i), tag = doc.tag(i), node = doc.nodes[i];
      if (!sources.has(value) && (styles.has(value) || ![...sources].some(source => value.includes(source)))) continue;
      if (kind === 'font' && !node.children.length && parents[i] >= 0 && doc.tag(parents[i]) === 'TextPrimitiveEntityDefinition' && textFields.has(tag) && !(tag === 'entityID' && sources.has(value))) continue;
      if (!sources.has(value) || !STYLE_TYPES[kind].references.has(tag) || node.children.length) throw new FormatError(`未対応の参照：${name} / ${tag} / node ${i}`);
      refs.push([name, i, tag]);
    }
    return refs;
  }
  plan(sourceIDs, target, kind = 'font') {
    const styles = this.stylesFor(kind), sources = new Set(typeof sourceIDs === 'string' ? [sourceIDs] : sourceIDs);
    if (!sources.size || [...sources].some(id => !styles.has(id))) throw new FormatError('統合元を選択してください。');
    if (!styles.has(target) || sources.has(target)) throw new FormatError('統合元以外の統合先を選択してください。');
    const seen = new Set(); let cursor = target;
    while (styles.has(cursor)) {
      if (sources.has(cursor) || seen.has(cursor)) throw new FormatError('統合先が統合元の子孫、または継承関係が循環しています。');
      seen.add(cursor); cursor = styles.get(cursor).parentEntityID || '';
    }
    const refs = [];
    for (const [name, doc] of this.docs) refs.push(...this.references(name, doc, sources, this.removedNodes(name, doc, sources, kind), kind));
    const needles = [...sources].flatMap(encodings);
    for (const [name, bytes] of this.data) if (!this.docs.has(name) && needles.some(needle => includesBytes(bytes, needle))) throw new FormatError(`DTN以外に参照があります：${name}`);
    return { sources, target, references: refs, kind };
  }
  applyMerge(sourceIDs, target, kind = 'font') {
    const plan = this.plan(sourceIDs, target, kind), docs = new Map([...this.docs].map(([name, doc]) => [name, doc.clone()]));
    for (const [name, i] of plan.references) docs.get(name).setValue(i, target);
    const data = new Map(this.data);
    for (const [name, doc] of docs) {
      const definitions = this.definitions.get(kind).get(name);
      doc.removeMany([...plan.sources].filter(id => definitions.has(id)).map(id => definitions.get(id).node));
      if (this.references(name, doc, plan.sources, new Set(), kind).length) throw new FormatError('統合元の参照が残っています。');
      data.set(name, doc.encode());
    }
    const result = new Project(this.archive, data);
    for (const type of Object.keys(STYLE_TYPES)) {
      const expected = [...this.stylesFor(type).keys()].filter(id => type !== kind || !plan.sources.has(id));
      const actual = result.stylesFor(type);
      if (actual.size !== expected.length || expected.some(id => !actual.has(id))) throw new FormatError('統合後のスタイル検証に失敗しました。');
    }
    return result;
  }
  async exportBytes() {
    const bytes = this.archive.write(this.data), verified = await Project.open(bytes);
    if (!equalBytes(verified.archive.comment, this.archive.comment) || this.data.size !== verified.data.size || [...this.data].some(([name, data]) => !verified.data.has(name) || !equalBytes(data, verified.data.get(name)))) throw new FormatError('保存後の検証に失敗しました。');
    return bytes;
  }
}
