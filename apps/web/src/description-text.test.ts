import { expect, test } from 'bun:test';
import { descriptionText } from './description-text.js';

test('partial unbold preserves italic emitted by the browser', () => {
  // 实际浏览器操作：整段加粗 → 中间两字斜体 → 取消中间两字加粗。
  expect(descriptionText('<b>甲</b><i style="">乙丙</i><b>丁</b>'))
    .toBe('<b>甲</b><i>乙丙</i><b>丁</b>');
});

test('retains independent nested formats while removing DOM attributes', () => {
  expect(descriptionText('<b class="x">战吼：<i style="">造成3点伤害。</i></b>'))
    .toBe('<b>战吼：<i>造成3点伤害。</i></b>');
});

test('normalizes semantic marks and preserves line breaks', () => {
  expect(descriptionText('<strong>加粗</strong><br><em>斜体</em><div>下一行</div>'))
    .toBe('<b>加粗</b>\n<i>斜体</i>\n下一行');
});

test('plain text after formatting cancellation has no residual tags', () => {
  expect(descriptionText('战吼：造成3点伤害。')).toBe('战吼：造成3点伤害。');
});
