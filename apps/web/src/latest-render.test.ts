import { expect, test } from 'bun:test';
import { LatestRender } from './latest-render.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// 三次编辑到达时，第一个已在运行；中间输入不得运行或覆盖最终结果。
test('coalesces queued edits, releases stale results, accepts only latest', async () => {
  const first = deferred<string>();
  const last = deferred<string>();
  const calls: string[] = [];
  const accepted: string[] = [];
  const released: string[] = [];
  const queue = new LatestRender<string, string>(value => {
    calls.push(value);
    return value === 'first' ? first.promise : last.promise;
  }, result => accepted.push(result), () => {}, result => released.push(result));
  queue.submit('first');
  queue.invalidate();
  queue.submit('middle');
  queue.invalidate();
  queue.submit('last');
  first.resolve('old-image');
  await first.promise;
  expect(calls).toEqual(['first', 'last']);
  expect(released).toEqual(['old-image']);
  expect(accepted).toEqual([]);
  last.resolve('new-image');
  await last.promise;
  expect(accepted).toEqual(['new-image']);
});

test('an edit invalidates a running result before debounce submits replacement', async () => {
  const job = deferred<string>();
  const accepted: string[] = [];
  const released: string[] = [];
  const queue = new LatestRender<string, string>(() => job.promise,
    value => accepted.push(value), () => {}, value => released.push(value));
  queue.submit('old');
  queue.invalidate();
  job.resolve('stale');
  await job.promise;
  expect(accepted).toEqual([]);
  expect(released).toEqual(['stale']);
});

test('ignores stale failure and processes latest input', async () => {
  const job = deferred<string>();
  const accepted: string[] = [];
  const errors: unknown[] = [];
  const queue = new LatestRender<string, string>(value => value === 'bad' ? job.promise : Promise.resolve(value),
    value => accepted.push(value), error => errors.push(error), () => {});
  queue.submit('bad');
  queue.invalidate();
  queue.submit('good');
  job.reject(new Error('obsolete'));
  await job.promise.catch(() => {});
  expect(errors).toEqual([]);
  expect(accepted).toEqual(['good']);
});

test('recovers after current error and releases late result after disposal', async () => {
  const job = deferred<string>();
  const errors: unknown[] = [];
  const accepted: string[] = [];
  const released: string[] = [];
  const queue = new LatestRender<string, string>(value => value === 'bad' ? Promise.reject(new Error('bad')) : job.promise,
    value => accepted.push(value), error => errors.push(error), value => released.push(value));
  queue.submit('bad');
  await Promise.resolve();
  expect(errors).toHaveLength(1);
  queue.invalidate();
  queue.submit('good');
  queue.dispose();
  job.resolve('late');
  await job.promise;
  expect(accepted).toEqual([]);
  expect(released).toEqual(['late']);
});
