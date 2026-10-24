export class FormatError extends Error {
  constructor(message) { super(message); this.name = 'FormatError'; }
}
export const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LIMIT = 2_000_000;

export class Writer {
  constructor() { this.buffer = new Uint8Array(1024); this.length = 0; }
  reserve(n) {
    if (this.length + n <= this.buffer.length) return;
    const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + n));
    next.set(this.buffer); this.buffer = next;
  }
  byte(v) { this.reserve(1); this.buffer[this.length++] = v; }
  bytes(v) { this.reserve(v.length); this.buffer.set(v, this.length); this.length += v.length; }
  u32(v) { this.reserve(4); new DataView(this.buffer.buffer).setUint32(this.length, v, true); this.length += 4; }
  variable(v) {
    while (v >= 128) { this.byte((v % 128) | 128); v = Math.floor(v / 128); }
    this.byte(v);
  }
  finish() { return this.buffer.slice(0, this.length); }
}

export class DTN {
  constructor(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    let position = 0;
    const need = n => {
      if (!Number.isSafeInteger(n) || n < 0 || position + n > data.length) throw new FormatError('DTNが途中で切れています。');
    };
    const byte = () => { need(1); return data[position++]; };
    const u32 = () => { need(4); const v = new DataView(data.buffer, data.byteOffset + position, 4).getUint32(0, true); position += 4; return v; };
    const variable = () => {
      let value = 0;
      for (let shift = 0; shift < 35; shift += 7) {
        const c = byte(); value += (c & 127) * 2 ** shift;
        if (!(c & 128)) {
          if (value > 0xffffffff) throw new FormatError('可変長整数が範囲外です。');
          return value;
        }
      }
      throw new FormatError('可変長整数が長すぎます。');
    };
    if (u32() !== 4 || u32() !== 1) throw new FormatError('未対応のDTNヘッダーです。');
    const table = () => {
      const count = u32();
      if (count > LIMIT) throw new FormatError('文字列辞書が大きすぎます。');
      const result = [];
      for (let i = 0; i < count; i++) {
        const end = data.indexOf(0, position);
        if (end < 0) throw new FormatError('文字列が終端されていません。');
        try { result.push(decoder.decode(data.subarray(position, end))); }
        catch { throw new FormatError('未対応の文字コードです。'); }
        position = end + 1;
      }
      return result;
    };
    this.tags = table(); this.values = table(); this.nodes = [];
    const count = u32();
    if (count > LIMIT) throw new FormatError('ノード数が上限を超えています。');
    for (let i = 0; i < count; i++) {
      const marker = byte();
      if (marker < 0xc0 || marker > 0xc3) throw new FormatError('未対応のノード形式です。');
      const tag = variable(), value = variable(), children = [];
      if (marker & 2) {
        const length = variable();
        if (length > count) throw new FormatError('子ノード数が範囲外です。');
        for (let j = 0; j < length; j++) children.push(variable());
      }
      this.nodes.push({ marker, tag, value, children });
    }
    if (position !== data.length) throw new FormatError('DTN末尾に未解析データがあります。');
    this.validate();
    if (!equalBytes(this.encode(), data)) throw new FormatError('無変更の再生成が原本と一致しません。');
  }
  tag(i) { return this.tags[this.nodes[i].tag]; }
  value(i) { return this.values[this.nodes[i].value]; }
  fields(i) {
    const fields = Object.create(null);
    for (const child of this.nodes[i].children) {
      const key = this.tag(child);
      if (Object.hasOwn(fields, key)) throw new FormatError('定義に重複フィールドがあります。');
      fields[key] = this.value(child);
    }
    return fields;
  }
  setValue(i, value) {
    let index = this.values.indexOf(value);
    if (index < 0) { index = this.values.length; this.values.push(value); }
    this.nodes[i].value = index;
  }
  subtree(root) {
    const result = new Set(), stack = [root];
    while (stack.length) {
      const i = stack.pop(); result.add(i);
      for (const child of this.nodes[i].children) stack.push(child);
    }
    return result;
  }
  clone() {
    const result = Object.create(DTN.prototype);
    result.tags = this.tags.slice(); result.values = this.values.slice();
    result.nodes = this.nodes.map(n => ({ ...n, children: n.children.slice() }));
    return result;
  }
  removeMany(roots) {
    const removed = new Set();
    for (const root of roots) for (const i of this.subtree(root)) removed.add(i);
    const mapping = new Int32Array(this.nodes.length).fill(-1), kept = [];
    for (let i = 0; i < this.nodes.length; i++) if (!removed.has(i)) { mapping[i] = kept.length; kept.push(i); }
    this.nodes = kept.map(i => ({ ...this.nodes[i], children: this.nodes[i].children.filter(c => !removed.has(c)).map(c => mapping[c]) }));
    this.validate();
  }
  validate() {
    if (!this.nodes.length) throw new FormatError('ルートノードがありません。');
    const parents = new Uint32Array(this.nodes.length);
    for (const node of this.nodes) {
      if (node.tag >= this.tags.length || node.value >= this.values.length) throw new FormatError('辞書の参照が範囲外です。');
      for (const child of node.children) {
        if (child <= 0 || child >= this.nodes.length) throw new FormatError('ノードの参照が範囲外です。');
        parents[child]++;
      }
    }
    if (parents[0] || parents.subarray(1).some(n => n !== 1)) throw new FormatError('未対応の共有ノードまたは孤立ノードがあります。');
    const seen = new Uint8Array(this.nodes.length), stack = [0]; let count = 0;
    while (stack.length) {
      const i = stack.pop();
      if (seen[i]) throw new FormatError('ノードに循環があります。');
      seen[i] = 1; count++;
      for (const child of this.nodes[i].children) stack.push(child);
    }
    if (count !== this.nodes.length) throw new FormatError('到達できないノードがあります。');
  }
  encode() {
    const out = new Writer(); out.u32(4); out.u32(1);
    for (const table of [this.tags, this.values]) {
      out.u32(table.length);
      for (const value of table) { out.bytes(encoder.encode(value)); out.byte(0); }
    }
    out.u32(this.nodes.length);
    for (const node of this.nodes) {
      out.byte(node.marker); out.variable(node.tag); out.variable(node.value);
      if (node.marker & 2) { out.variable(node.children.length); for (const child of node.children) out.variable(child); }
    }
    return out.finish();
  }
}
