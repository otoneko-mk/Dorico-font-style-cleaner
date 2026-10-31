import { Project } from './project.js';
import { FormatError } from './dtn.js';

const MAX_STEPS = 32;
const MAX_HISTORY_BYTES = 64 * 1024 ** 2;
const snapshot = (session) => ({
  data: session.project.data,
  revision: session.revision,
});
const weight = (item) =>
  [...item.data].reduce(
    (size, [name, bytes]) => size + (name.endsWith('.dtn') ? bytes.length : 0),
    0,
  );

export class Session {
  constructor(project) {
    this.project = project;
    this.past = [];
    this.future = [];
    this.revision = 0;
    this.nextRevision = 0;
  }
  payload(bytes) {
    return {
      catalogs: this.project.state(),
      bytes: bytes.buffer,
      revision: this.revision,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    };
  }
  async initial() {
    return this.payload(await this.project.exportBytes());
  }
  async merge(sources, target, kind) {
    const next = this.project.applyMerge(sources, target, kind);
    const bytes = await next.exportBytes();
    this.past.push(snapshot(this));
    this.future = [];
    let size = this.past.reduce((sum, item) => sum + weight(item), 0);
    while (this.past.length > MAX_STEPS || size > MAX_HISTORY_BYTES)
      size -= weight(this.past.shift());
    this.project = next;
    this.revision = ++this.nextRevision;
    return this.payload(bytes);
  }
  async move(direction) {
    const from = direction === 'undo' ? this.past : this.future;
    const to = direction === 'undo' ? this.future : this.past;
    if (!from.length)
      throw new FormatError(
        direction === 'undo'
          ? '元に戻せる操作がありません。'
          : 'やり直せる操作がありません。',
      );
    const item = from.at(-1),
      next = new Project(this.project.archive, item.data);
    const bytes = await next.exportBytes();
    from.pop();
    to.push(snapshot(this));
    this.project = next;
    this.revision = item.revision;
    return this.payload(bytes);
  }
}
