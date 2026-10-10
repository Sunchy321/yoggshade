/** fail-fast 错误模型：数据缺口/坏输入 → 抛错（不静默吞）；渲染层负责捕获处理。 */
import { describe, expect, test } from 'bun:test';
import { resolveCardText, resolveEntityText, resolveFixtureText } from '../src/index.js';

describe('fail-fast error model', () => {
  test('未知 textBuilderType → 抛', () => {
    expect(() => resolveCardText({ builderType: 999, cardId: 'X', text: '文', tags: {} }))
      .toThrow(/unknown textBuilderType 999/);
    expect(() => resolveEntityText({ builderType: 999, cardId: 'X', text: '文', tags: {} }))
      .toThrow(/unknown textBuilderType 999/);
  });
  test('非有限 tag 值 → 抛（不静默变 0）', () => {
    expect(() => resolveCardText({ builderType: 7, cardId:      'X', text:        '打@',
      tags:        { 2: 'abc' as unknown as number } })).toThrow(/tag 2 value "abc" is not finite/);
    expect(() => resolveCardText({ builderType: 7, cardId:      'X', text:        '打@',
      tags:        { 2: Number.NaN } })).toThrow(/not finite/);
  });
  test('钩子抛异常 → 原样透传（不吞）', () => {
    expect(() => resolveCardText({ builderType: 8, cardId:      'X', text:        '进@',
      tags:        { 2: 1, 3: 2 },
      lookup:      { gameString: () => { throw new Error('boom'); } } })).toThrow('boom');
  });
  test('正常输入不抛', () => {
    expect(resolveCardText({ builderType: 7, cardId: 'X', text: '打@', tags: { 2: 5 } }).text)
      .toBe('打5');
  });
});

describe('degraded-but-valid inputs (still processed, no throw)', () => {
  test('空文本', () => {
    expect(resolveCardText({ builderType: 0, cardId: 'X', text: '', tags: {} }).text).toBe('');
  });
  test('负数 tag 合法（SCRIPT_DATA 可负）', () => {
    expect(resolveCardText({ builderType: 7, cardId: 'X', text: '打@', tags: { 2: -5 } }).text)
      .toBe('打-5');
  });
  test('字符串数字 tag 数值化', () => {
    expect(resolveCardText({ builderType: 7, cardId:      'X', text:        '打@',
      tags:        { 2: '6' as unknown as number } }).text).toBe('打6');
  });
  test('{999} 超界占位符保留（C# string.Format 异常→原文语义）', () => {
    expect(resolveCardText({ builderType: 26, cardId:      'X', text:        '{0}/{1}/{999}',
      tags:        { 2: 1, 3: 2 } }).text).toBe('1/2/{999}');
  });
  test('16 HIDDEN_CHOICE 越界 → 返回原文（GetCorrectSubstring 反编译语义）', () => {
    expect(resolveCardText({ builderType: 16, cardId: 'X', text: 'A@B', tags: { 813: 5 } }).text)
      .toBe('A@B');
  });
  test('34 单模块无卡库数据 → 空串（登记退化），不抛', () => {
    expect(resolveCardText({ builderType: 34, cardId:      'TOY_330', text:        '默认文本',
      tags:        { 471: 104944 } }).text).toBe('');
  });
});

describe('resolveFixtureText lang 贯穿（locale → 复数规则 + 内嵌数据语言）', () => {
  const fixture = {
    textBuilderType: 26,
    textInHand:      { zhCN: '抽{0}|4(张,张).', enUS: 'Draw {0}|4(Card,Cards).' },
    tags:            { 2: 0 },
  };
  test('zhCN |4 数字 0 → 段0（≤1 口径；enUS 口径会错选段1）', () => {
    expect(resolveFixtureText(fixture, 'zhCN').text).toBe('抽0张.');
  });
  test('enUS |4 数字 0 → 段1（==1 单数口径）', () => {
    expect(resolveFixtureText(fixture, 'enUS').text).toBe('Draw 0Cards.');
  });
  test('lang 同时驱动内嵌数据（卡名占位随语言）', () => {
    const f = { textBuilderType: 30, textInHand: { zhCN: '由{0}创造', enUS: 'Created by {0}' }, tags: {} };
    expect(resolveFixtureText(f, 'zhCN').text).toBe('由某张牌创造');
    expect(resolveFixtureText(f, 'enUS').text).toBe('Created by another card');
  });
});

describe('12 MULTIPLE_ENTITY_NAMES 双路径（EntityDef UNKNOWN / Entity 空串）', () => {
  test('EntityDef: tag==0 → UNKNOWN 占位', () => {
    expect(resolveCardText({ builderType: 12, cardId:      'X', text:        '{0}和{1}',
      tags:        { 2655: 10, 2656: 0 },
      lookup:      { entityName: d => (d === 10 ? '火球术' : undefined) } }).text)
      .toBe('火球术和某张牌');
  });
  test('Entity: tag==0 → 空串（BuildText :70-73）', () => {
    expect(resolveEntityText({ builderType: 12, cardId:      'X', text:        '{0}和{1}',
      tags:        { 2655: 10, 2656: 0 },
      lookup:      { entityName: d => (d === 10 ? '火球术' : undefined) } }).text)
      .toBe('火球术和');
  });
});
