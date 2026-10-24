import { FormatError, equalBytes } from './dtn.js';

export const MAX_SIZE = 256 * 1024 ** 2;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
const u16 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
const set16 = (bytes, offset, value) => new DataView(bytes.buffer, bytes.byteOffset + offset, 2).setUint16(0, value, true);
const set32 = (bytes, offset, value) => new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value, true);
export function concat(parts) {
  const result = new Uint8Array(parts.reduce((n, bytes) => n + bytes.length, 0));
  let position = 0;
  for (const bytes of parts) { result.set(bytes, position); position += bytes.length; }
  return result;
}

async function inflate(data, length) {
  let stream;
  try { stream = new DecompressionStream('deflate-raw'); }
  catch { throw new FormatError('このブラウザーはZIP展開に対応していません。最新版のブラウザーを使用してください。'); }
  const reader = new Blob([data]).stream().pipeThrough(stream).getReader();
  const parts = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > length || size > MAX_SIZE) throw new FormatError('ZIPの展開サイズが不正です。');
      parts.push(item.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof FormatError ? error : new FormatError('ZIPを展開できません。');
  } finally { reader.releaseLock(); }
  return concat(parts);
}

export class ZipArchive {
  constructor(input) {
    this.original = input instanceof Uint8Array ? input : new Uint8Array(input);
    const data = this.original;
    if (data.length > MAX_SIZE) throw new FormatError('ファイルサイズが256 MiBを超えています。');
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
      if (u32(data, i) === 0x06054b50 && i + 22 + u16(data, i + 20) === data.length) { end = i; break; }
    }
    if (end < 0) throw new FormatError('有効なZIPファイルではありません。');
    const count = u16(data, end + 10), size = u32(data, end + 12), start = u32(data, end + 16);
    if (u16(data, end + 4) || u16(data, end + 6) || u16(data, end + 8) !== count) throw new FormatError('分割ZIPには対応していません。');
    if (count === 65535 || size === 0xffffffff || start === 0xffffffff) throw new FormatError('ZIP64には対応していません。');
    if (start + size !== end) throw new FormatError('未対応のZIP構造です。');
    this.comment = data.slice(end + 22); this.entries = []; this.byName = new Map();
    let position = start, total = 0;
    for (let i = 0; i < count; i++) {
      if (position + 46 > end || u32(data, position) !== 0x02014b50) throw new FormatError('ZIP索引が壊れています。');
      const nameLength = u16(data, position + 28), extraLength = u16(data, position + 30), commentLength = u16(data, position + 32);
      const length = 46 + nameLength + extraLength + commentLength;
      if (position + length > end) throw new FormatError('ZIP索引が途中で切れています。');
      const central = data.slice(position, position + length);
      const flags = u16(central, 8), method = u16(central, 10), compressed = u32(central, 20), uncompressed = u32(central, 24), offset = u32(central, 42);
      if (flags & 0x41) throw new FormatError('暗号化ZIPには対応していません。');
      if (![0, 8].includes(method)) throw new FormatError('未対応のZIP圧縮方式です。');
      if (compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff || u16(central, 34)) throw new FormatError('未対応のZIP構造です。');
      let name;
      try { name = decoder.decode(central.subarray(46, 46 + nameLength)); }
      catch { throw new FormatError('ZIP項目名の文字コードに対応していません。'); }
      if (this.byName.has(name)) throw new FormatError('ZIP内に同名項目があります。');
      total += uncompressed;
      if (total > MAX_SIZE) throw new FormatError('展開後のサイズが256 MiBを超えています。');
      if (offset + 30 > start || u32(data, offset) !== 0x04034b50) throw new FormatError('ZIPのローカルヘッダーが不正です。');
      const headerLength = 30 + u16(data, offset + 26) + u16(data, offset + 28);
      const dataStart = offset + headerLength;
      if (dataStart + compressed > start || u16(data, offset + 6) !== flags || u16(data, offset + 8) !== method) throw new FormatError('ZIPヘッダーが一致しません。');
      if (!equalBytes(data.subarray(offset + 30, offset + 30 + u16(data, offset + 26)), central.subarray(46, 46 + nameLength))) throw new FormatError('ZIP項目名が一致しません。');
      const entry = { name, central, flags, method, compressed, uncompressed, crc: u32(central, 16), offset,
        localHeader: data.slice(offset, dataStart), compressedData: data.subarray(dataStart, dataStart + compressed) };
      this.entries.push(entry); this.byName.set(name, entry); position += length;
    }
    if (position !== end || !count) throw new FormatError('ZIP索引のサイズが不正です。');
    this.localOrder = this.entries.slice().sort((a, b) => a.offset - b.offset);
    if (this.localOrder[0].offset !== 0) throw new FormatError('未対応のZIP先頭データがあります。');
    for (let i = 0; i < this.localOrder.length; i++) {
      const entry = this.localOrder[i], stop = this.localOrder[i + 1]?.offset ?? start;
      if (entry.offset + entry.localHeader.length + entry.compressed > stop) throw new FormatError('ZIP項目が重複しています。');
      entry.localRaw = data.subarray(entry.offset, stop);
    }
  }
  async unpack() {
    const data = new Map();
    for (const entry of this.entries) {
      const bytes = entry.method === 0 ? entry.compressedData.slice() : await inflate(entry.compressedData, entry.uncompressed);
      if (bytes.length !== entry.uncompressed || crc32(bytes) !== entry.crc) throw new FormatError(`ZIPの検証に失敗しました：${entry.name}`);
      entry.bytes = bytes; data.set(entry.name, bytes);
    }
    return data;
  }
  write(data) {
    const locals = [], centrals = new Map(); let offset = 0;
    for (const entry of this.localOrder) {
      const bytes = data.get(entry.name);
      if (!bytes) throw new FormatError('ZIP項目が不足しています。');
      let raw = entry.localRaw, central = entry.central.slice();
      if (!equalBytes(bytes, entry.bytes)) {
        const header = entry.localHeader.slice(), crc = crc32(bytes), flags = entry.flags & ~8;
        set16(header, 6, flags); set16(header, 8, 0); set32(header, 14, crc); set32(header, 18, bytes.length); set32(header, 22, bytes.length);
        set16(central, 8, flags); set16(central, 10, 0); set32(central, 16, crc); set32(central, 20, bytes.length); set32(central, 24, bytes.length);
        raw = concat([header, bytes]);
      }
      set32(central, 42, offset); centrals.set(entry.name, central); locals.push(raw); offset += raw.length;
    }
    const directory = concat(this.entries.map(entry => centrals.get(entry.name)));
    const end = new Uint8Array(22);
    set32(end, 0, 0x06054b50); set16(end, 8, this.entries.length); set16(end, 10, this.entries.length);
    set32(end, 12, directory.length); set32(end, 16, offset); set16(end, 20, this.comment.length);
    return concat([...locals, directory, end, this.comment]);
  }
}
