import type { MetaResponse, RenderRequest } from './shared.js';

export type WorkerRequest = { id: number, kind: 'meta' } | { id: number, kind: 'render', body: RenderRequest };
export interface WorkerRenderResult { blob: Blob, ms: number, slot: string }
export type WorkerResponse
  = | { id: number, kind: 'meta', result: MetaResponse }
    | { id: number, kind: 'render', result: WorkerRenderResult }
    | { id: number, kind: 'error', error: { name: string, message: string, char?: string } };
