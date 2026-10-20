import { useLayoutEffect, useRef, useState } from 'react';
import { LatestRender } from './latest-render.js';
import { renderClient, type RenderResult } from './render-client.js';
import type { RenderRequest } from './shared.js';

export function useAutoRender(body: RenderRequest, enabled: boolean, composing: boolean) {
  const [png, setPng] = useState<string>();
  const [status, setStatus] = useState<'waiting' | 'updating' | 'updated' | 'error'>('waiting');
  const [error, setError] = useState<unknown>();
  const image = useRef<string | undefined>(undefined);
  const scheduler = useRef<LatestRender<RenderRequest, RenderResult> | undefined>(undefined);

  useLayoutEffect(() => {
    const queue = new LatestRender<RenderRequest, RenderResult>(renderClient, result => {
      if (image.current) URL.revokeObjectURL(image.current);
      image.current = result.url;
      setPng(result.url);
      setError(undefined);
      setStatus('updated');
    }, cause => {
      setError(cause);
      setStatus('error');
    }, result => URL.revokeObjectURL(result.url));
    scheduler.current = queue;
    return () => {
      queue.dispose();
      if (image.current) URL.revokeObjectURL(image.current);
      image.current = undefined;
      scheduler.current = undefined;
    };
  }, []);

  useLayoutEffect(() => {
    const queue = scheduler.current;
    if (!queue) return;
    queue.invalidate();
    setError(undefined);
    setStatus('waiting');
    if (!enabled || composing) return;
    const timer = setTimeout(() => {
      setStatus('updating');
      queue.submit(body);
    }, 300);
    return () => clearTimeout(timer);
  }, [body, enabled, composing]);

  return { png, status, error };
}
