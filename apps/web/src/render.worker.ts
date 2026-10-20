import { loadMetaClient, renderClient } from './render-engine.js';
import type { WorkerRequest, WorkerResponse } from './render-protocol.js';

// 同一像素管线只改变执行线程；避免同步光栅化阻塞编辑（性能实测见
// explore/2026-10-20-auto-render-perf/findings.md：缓存命中仍停顿 226–285ms）。
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};
scope.onmessage = event => {
  const request = event.data;
  void (async () => {
    try {
      if (request.kind === 'meta') {
        scope.postMessage({ id: request.id, kind: 'meta', result: await loadMetaClient() });
      } else {
        scope.postMessage({ id: request.id, kind: 'render', result: await renderClient(request.body) });
      }
    } catch (cause) {
      const error = cause as Error & { char?: string };
      scope.postMessage({ id:    request.id, kind:  'error', error: {
        name: error.name ?? 'Error', message: error.message ?? String(cause), char: error.char,
      } });
    }
  })();
};
