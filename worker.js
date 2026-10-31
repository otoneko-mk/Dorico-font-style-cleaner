import { Project } from './core/project.js';
import { Session } from './core/session.js';

let session = null;
self.onmessage = async ({ data: request }) => {
  try {
    let result;
    if (request.action === 'open') {
      const next = new Session(
        await Project.open(new Uint8Array(request.bytes)),
      );
      result = await next.initial();
      session = next;
    } else {
      if (!session) throw new Error('ファイルを開いてください。');
      if (request.action === 'merge')
        result = await session.merge(
          request.sources,
          request.target,
          request.kind,
        );
      else if (request.action === 'undo' || request.action === 'redo')
        result = await session.move(request.action);
      else if (request.action === 'save') {
        const bytes = await session.project.exportBytes();
        self.postMessage({ id: request.id, ok: true, result: bytes.buffer }, [
          bytes.buffer,
        ]);
        return;
      } else throw new Error('未対応の操作です。');
    }
    self.postMessage({ id: request.id, ok: true, result }, [result.bytes]);
  } catch (error) {
    self.postMessage({
      id: request.id,
      ok: false,
      message: error?.message || String(error),
    });
  }
};
