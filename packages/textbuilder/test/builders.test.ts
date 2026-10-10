/** 47 类型语义用例（静态 EntityDef + 运行时 Entity 双路径；期望值对译自各 builder 反编译）。 */
import { describe, expect, test } from 'bun:test';
import { resolveCardText, resolveEntityText } from '../src/index.js';

describe('static (EntityDef) path', () => {
  test('0 DEFAULT: $/# token stripped (no bonus)', () => {
    expect(resolveCardText({ builderType: 0, cardId: 'X', text: '造成$3点伤害。', tags: {} }).text)
      .toBe('造成3点伤害。');
  });
  test('2 JADE_GOLEM_TRIGGER: @ 后段', () => {
    expect(resolveCardText({ builderType: 2, cardId: 'CFM_902', text: '召唤{0}。@战吼。', tags: {} }).text)
      .toBe('战吼。');
  });
  test('4 KAZAKUS: @ 前段', () => {
    expect(resolveCardText({ builderType: 4, cardId: 'X', text: '前段@后段', tags: {} }).text).toBe('前段');
  });
  test('6 ALTERNATE_CARD_TEXT: 955 段选择', () => {
    const t = (tags: Record<string, number>) =>
      resolveCardText({ builderType: 6, cardId: 'X', text: 'A@B@C', tags }).text;
    expect(t({})).toBe('A');
    expect(t({ 955: 1 })).toBe('B');
    expect(t({ 955: 2 })).toBe('C');
  });
  test('7 SCRIPT_DATA_NUM_1: @→NUM_1', () => {
    expect(resolveCardText({ builderType: 7, cardId: 'X', text: '还剩@次', tags: { 2: 2 } }).text)
      .toBe('还剩2次');
  });
  test('8 GALAKROND_COUNTER: 内置 GameStrings', () => {
    expect(resolveCardText({ builderType: 8, cardId: 'X', text: '进化@', tags: { 2: 2, 3: 3 } }).text)
      .toBe('进化被<b>祈求</b>一次后升级。');
  });
  test('12 MULTIPLE_ENTITY_NAMES: 引用实体名', () => {
    expect(resolveCardText({
      builderType: 12, cardId:      'X', text:        '{0}和{1}',
      tags:        { 2655: 10, 2656: 0 },
      lookup:      { entityName: d => (d === 10 ? '火球术' : undefined) },
    }).text).toBe('火球术和某张牌'); // 内置 zhCN UNKNOWN fallback
  });
  test('16 HIDDEN_CHOICE: Split(@)[idx]', () => {
    expect(resolveCardText({ builderType: 16, cardId: 'X', text: 'A@B@C', tags: { 813: 1 } }).text).toBe('B');
  });
  test('19 REF_SDN1_ENTITY: @→NUM_2, {0}→NUM_1 实体名', () => {
    expect(resolveCardText({
      builderType: 19, cardId:      'X', text:        '从{0}获得@',
      tags:        { 2: 3, 3: 7 },
      lookup:      { entityName: d => (d === 3 ? '法师' : undefined) },
    }).text).toBe('从法师获得7');
  });
  test('22 SPELL_DAMAGE_ONLY 静态: bonus=0', () => {
    expect(resolveCardText({ builderType: 22, cardId: 'X', text: '造成$3点伤害', tags: {} }).text)
      .toBe('造成3点伤害');
  });
  test('24 HIDDEN_ENTITY: choice→段1+卡名', () => {
    expect(resolveCardText({
      builderType: 24, cardId:      'X', text:        '隐藏@揭示{0}',
      tags:        { 813: 5 }, lookup:      { cardName: d => (d === 5 ? '奥秘卡' : undefined) },
    }).text).toBe('揭示奥秘卡');
    expect(resolveCardText({ builderType: 24, cardId: 'X', text: '隐藏@揭示', tags: {} }).text).toBe('隐藏');
  });
  test('25 SCORE_VALUE_COUNT_DOWN 静态: @→SCORE_VALUE_1', () => {
    expect(resolveCardText({ builderType: 25, cardId: 'X', text: '还剩@次', tags: { 451: 3 } }).text)
      .toBe('还剩3次');
  });
  test('26 SDN1_NUM2: TryFormat {0}/{1}', () => {
    expect(resolveCardText({ builderType: 26, cardId: 'X', text: '+{0}/+{1}', tags: { 2: 6, 3: 6 } }).text)
      .toBe('+6/+6');
  });
  test('28 MULTI_ALT_TEXT: 段选择 + TryFormat', () => {
    expect(resolveCardText({ builderType: 28, cardId:      'X', text:        '{0}枚@金色{1}@备用',
      tags:        { 2: 15, 3: 5 } }).text).toBe('15枚');
  });
  test('30 REF_SDN1_CARD_DBID: 卡名 / UNKNOWN fallback', () => {
    expect(resolveCardText({ builderType: 30, cardId:      'X', text:        '由{0}创造',
      tags:        { 2: 1000 }, lookup:      { cardName: d => (d === 1000 ? '奇利亚斯' : undefined) } }).text)
      .toBe('由奇利亚斯创造');
    expect(resolveCardText({ builderType: 30, cardId: 'X', text: '由{0}创造', tags: {} }).text)
      .toBe('由某张牌创造');
  });
  test('31 NUM_CARD_RACE: @→进度, {0}→种族名（内置 races 表）', () => {
    expect(resolveCardText({ builderType: 31, cardId:      'X', text:        '击败@个{0}。',
      tags:        { 535: 3, 2: 4 } }).text).toBe('击败3个侏儒。'); // TAG_RACE 4=GNOME
  });
  test('38 ALT_REF_ENTITY_POWER EntityDef: 955 分段', () => {
    expect(resolveCardText({ builderType: 38, cardId: 'X', text: '前段@后段', tags: { 955: 1 } }).text)
      .toBe('后段');
  });
  test('39 REWIND 静态: 原样', () => {
    expect(resolveCardText({ builderType: 39, cardId: 'X', text: '<b>Rewind</b>效果。', tags: {} }).text)
      .toBe('<b>Rewind</b>效果。');
  });
  test('41 DYNAMIC_KEYWORD: 内置关键词名', () => {
    expect(resolveCardText({ builderType: 41, cardId:      'X', text:        '获得{0}与{1}。',
      tags:        { 4161: 190, 4162: 194 } }).text).toBe('获得嘲讽与圣盾。');
  });
  test('42 REF_SDN1_CLASS: classIndex!=0 → @ 后段 + {0} 职业名', () => {
    expect(resolveCardText({ builderType: 42, cardId:      'X', text:        '你的职业@牌{0}',
      tags:        { 2: 4 } }).text).toBe('牌法师');
    expect(resolveCardText({ builderType: 42, cardId: 'X', text: '你的职业@牌{0}', tags: {} }).text)
      .toBe('你的职业');
  });
  test('43 HERALD: 内置 GAMEPLAY_HERALD_DEFAULT', () => {
    expect(resolveCardText({ builderType: 43, cardId:      'X', text:        '召唤{0}，它{1}个',
      tags:        { 2: 2 } }).text).toBe('召唤你的巨型随从，它2个');
  });
  test('45 DEEP_BLUES 静态: 无加成', () => {
    expect(resolveCardText({ builderType: 45, cardId:      'X', text:        '获得{0}/{1}',
      tags:        { 2: 2, 3: 3 } }).text).toBe('获得2/3');
  });
  test('46 SILVER_HAND 静态: 1/1', () => {
    expect(resolveCardText({ builderType: 46, cardId: 'X', text: '召唤一个{0}的随从' }).text)
      .toBe('召唤一个1/1的随从');
  });
});

describe('runtime (Entity) path', () => {
  test('1 JADE_GOLEM zone=play: @ 后段', () => {
    expect(resolveEntityText({ builderType: 1, cardId:      'X', text:        '召唤{0}。@战吼。',
      tags:        {}, runtime:     { zone: 'play' } }).text).toBe('战吼。');
  });
  test('9 DECORATE: TryFormat(COST, NUM_2)', () => {
    expect(resolveEntityText({ builderType: 9, cardId:      'X', text:        '升级为{0}花费。进度{1}',
      tags:        { 48: 5, 3: 2 } }).text).toBe('升级为5花费。进度2');
  });
  test('10 PLAYER_TAG_THRESHOLD: 阈值三段', () => {
    const r = (controller: number) => resolveEntityText({
      builderType: 10, cardId:      'X', text:        '已达标@还差{0}。@就绪。',
      tags:        { 1115: 40, 1116: 10 }, runtime:     { controllerTag: () => controller },
    }).text;
    expect(r(10)).toBe('已达标就绪。');
    expect(r(5)).toBe('已达标还差5。'); // 未达标=前缀+中段（尾段属达标态）
  });
  test('22 SPELL_DAMAGE_ONLY: bonus → *5*', () => {
    expect(resolveEntityText({ builderType: 22, cardId:      'X', text:        '造成$3点伤害',
      tags:        {}, bonuses:     { damage: 2 } }).text).toBe('造成*5*点伤害');
  });
  test('25 SCORE_VALUE_COUNT_DOWN: 余量', () => {
    expect(resolveEntityText({ builderType: 25, cardId:      'X', text:        '还剩@次',
      tags:        { 451: 3, 453: 1 } }).text).toBe('还剩2次');
  });
  test('36 BGZILLIAX: 内置底卡关键词表 + keywordName', () => {
    expect(resolveCardText({ builderType: 36, cardId:      'X', text:        '本题@。',
      tags:        { 1471: 107909, 3499: 107911 } }).text).toBe('本题嘲讽\n圣盾。');
  });
  test('39 REWIND used: 删关键词', () => {
    expect(resolveEntityText({ builderType: 39, cardId:      'X', text:        '<b>Rewind</b>效果。',
      tags:        { 3945: 1 } }).text).toBe('效果。');
  });
  test('45 DEEP_BLUES: BACON_DEEP_BLUE 加成', () => {
    expect(resolveEntityText({ builderType: 45, cardId:      'X', text:        '获得{0}/{1}',
      tags:        { 2: 2, 3: 3 }, runtime:     { localPlayerTag: t => (t === 2850 ? 1 : 0) } }).text)
      .toBe('获得4/6');
  });
});

describe('degradation & data-bound builders', () => {
  test('3 MODULAR_ENTITY / 17 INVESTIGATE 静态: 空串（游戏语义）', () => {
    expect(resolveCardText({ builderType: 3, cardId: 'X', text: '任何文本', tags: {} }).text).toBe('');
    expect(resolveCardText({ builderType: 17, cardId: 'X', text: '任何文本', tags: {} }).text).toBe('');
  });
  test('15 ZOMBEAST_ENCHANTMENT: 模块名', () => {
    expect(resolveCardText({ builderType: 15, cardId:      'X', text:        '{0}与{1}',
      tags:        { 471: 100, 472: 200 },
      lookup:      { cardName: d => (d === 100 ? '食腐' : d === 200 ? '风怒' : undefined) } }).text)
      .toBe('食腐与风怒');
  });
  test('34 ZILLIAX: 双模块组合文本（内置组合表 + GameStrings）', () => {
    const r = resolveCardText({ builderType: 34, cardId:      'TOY_330', text:        '占位',
      tags:        { 471: 104948, 472: 104951 } });
    expect(r.text).toContain('<b>'); // ZILLIAX_DELUXE_COMBINED_MODULE_1_2 内置文本
  });
});
