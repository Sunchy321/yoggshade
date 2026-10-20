/** 主线程只传递请求、创建预览 URL；像素管线和资产缓存在独立 worker。 */
import type { MetaResponse, RenderRequest } from './shared.js';
import type { WorkerRequest, WorkerResponse, WorkerRenderResult } from './render-protocol.js';

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, {
  resolve(value: MetaResponse | WorkerRenderResult): void;
  reject(error: Error): void;
}>();

function fail(error: Error): void {
  worker?.terminate();
  worker = undefined;
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    if (response.kind === 'error') {
      entry.reject(Object.assign(new Error(response.error.message), response.error));
    } else {
      entry.resolve(response.result);
    }
  };
  worker.onerror = () => fail(new Error('渲染器启动失败，请刷新重试。'));
  worker.onmessageerror = () => fail(new Error('渲染结果读取失败，请重试。'));
  return worker;
}

function send(request: WorkerRequest): Promise<MetaResponse | WorkerRenderResult> {
  return new Promise((resolve, reject) => {
    try {
      const target = getWorker();
      pending.set(request.id, { resolve, reject });
      target.postMessage(request);
    } catch (error) {
      pending.delete(request.id);
      reject(error);
    }
  });
}

export interface RenderResult { url: string, ms: number, slot: string }

export async function renderClient(body: RenderRequest): Promise<RenderResult> {
  const result = await send({ id: ++nextId, kind: 'render', body }) as WorkerRenderResult;
  const url = URL.createObjectURL(result.blob);
  try {
    // 新图解码完成才替换旧预览，避免自动更新时出现空白帧。
    const image = new Image();
    image.src = url;
    await image.decode();
    return { url, ms: result.ms, slot: result.slot };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function loadMetaClient(): Promise<MetaResponse> {
  return await send({ id: ++nextId, kind: 'meta' }) as MetaResponse;
}

if (import.meta.hot) import.meta.hot.dispose(() => fail(new Error('页面已更新。')));
