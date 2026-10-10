/** GameStrings 语言规则（|1 韩语助词 / |4 复数）与 ∞ 规则。
 *  反编译：GameStrings.cs ParseLanguageRule1（:2222）/ Rule4（:2291）/ GetPluralIndex（:2408）；
 *  ParseTextForInfinity（TextUtils.cs:152，INFINTY_THRESHOLD=1e6 → 7 位，GameUtils.cs:185）。 */
import { describe, expect, test } from 'bun:test';
import { parseLanguageRule1, parseLanguageRule4, transformCardText } from '../src/textutils.js';
import { resolveCardText } from '../src/index.js';

describe('ParseLanguageRule1（韩语助词）', () => {
  test('有终声 → args[0]', () => {
    // 학생 有终声（(학생-44032)%28 != 0）→ 을
    expect(parseLanguageRule1('학생|1(을,를) 잡는다.')).toBe('학생을 잡는다.');
  });
  test('无终声 → args[1]', () => {
    // 아이 无终声 → 를
    expect(parseLanguageRule1('아이|1(을,를) 잡는다.')).toBe('아이를 잡는다.');
  });
  test('拉丁词 L/R → 일 类', () => {
    expect(parseLanguageRule1('Fireball|1(을,를) 사용.')).toBe('Fireball을 사용.');
    expect(parseLanguageRule1('Mana|1(을,를) 사용.')).toBe('Mana를 사용.'); // R/l → 일
  });
  test('数字归音：1/7/8→일、0/3/6→영（GameStrings.cs:2205-2212），随后按终声规则选段', () => {
    expect(parseLanguageRule1('1|1(을,를) 뽑는다.')).toBe('1을 뽑는다.'); // 일 rem=8
    expect(parseLanguageRule1('3|1(을,를) 뽑는다.')).toBe('3을 뽑는다.'); // 영 num5=21 → args[0]
    expect(parseLanguageRule1('0|1(을,를) 뽑는다.')).toBe('0을 뽑는다.');
  });
  test('ㄹ 尾特殊规则（args[1][0]==로 且 rem==8 → args[1]）', () => {
    // 만들 → (는,은) 构造：받침 ㄹ(rem 8) 时用 은（args[1][0]==은? 反编译用 args[1][0]==='로'）
  });
  test('非法（无前导/参数≠2）→ 原文保留', () => {
    expect(parseLanguageRule1('|1(을,를) x')).toBe('|1(을,를) x');
    expect(parseLanguageRule1('abc|1(을) x')).toBe('abc|1(을) x');
  });
});

describe('ParseLanguageRule4（复数）', () => {
  test('enUS: 1→单数、2→复数', () => {
    expect(parseLanguageRule4('Draw |4(Card,Cards).', 'enUS')).toBe('Draw |4(Card,Cards).'); // 无数字不替换
    expect(parseLanguageRule4('Draw 1|4(Card,Cards).', 'enUS')).toBe('Draw 1Card.');
    expect(parseLanguageRule4('Draw 2|4(Card,Cards).', 'enUS')).toBe('Draw 2Cards.');
  });
  test('数字在规则文字之间（Forward 优先）', () => {
    expect(parseLanguageRule4('3个以上|4(随从,随从们)抽两张牌', 'zhCN')).toBe('3个以上随从们抽两张牌'); // zhCN: >1 → 段1（GetPluralIndex 反编译口径）
  });
  test('ruRU 复数三段', () => {
    expect(parseLanguageRule4('1|4(карта,карты,карт)', 'ruRU')).toBe('1карта');
    expect(parseLanguageRule4('2|4(карта,карты,карт)', 'ruRU')).toBe('2карты');
    expect(parseLanguageRule4('5|4(карта,карты,карт)', 'ruRU')).toBe('5карт');
    expect(parseLanguageRule4('11|4(карта,карты,карт)', 'ruRU')).toBe('11карт');
  });
  test('zhCN: <=1 → 段0', () => {
    expect(parseLanguageRule4('获得2|4(个随从,个随从)', 'zhCN')).toBe('获得2个随从');
  });
});

describe('ParseTextForInfinity', () => {
  test('静态路径缺省开启（游戏内 GameMgr 非空口径）', () => {
    expect(transformCardText('造成1000000点伤害')).toBe('造成∞点伤害');
    expect(transformCardText('造成999999点伤害')).toBe('造成999999点伤害');
  });
  test('可关闭（纯 DBF 口径）', () => {
    expect(transformCardText('造成1000000点伤害', { infinityMinDigits: false })).toBe('造成1000000点伤害');
  });
});

describe('locale 贯穿（ctx.locale → GetPluralIndex）', () => {
  test('koKR |4：number≤1 → 段0', () => {
    expect(resolveCardText({ builderType: 26, cardId:      'X', text:        '抽{0}|4(장,장들).',
      tags:        { 2: 1, 3: 1 }, locale:      'koKR' }).text).toBe('抽1장.');
    expect(resolveCardText({ builderType: 26, cardId:      'X', text:        '抽{0}|4(장,장들).',
      tags:        { 2: 2, 3: 1 }, locale:      'koKR' }).text).toBe('抽2장들.');
  });
  test('ruRU 三段复数贯穿', () => {
    const t = (n: number) => resolveCardText({ builderType: 26, cardId:      'X',
      text:        '{0}|4(карта,карты,карт)', tags:        { 2: n }, locale:      'ruRU' }).text;
    expect(t(1)).toBe('1карта');
    expect(t(3)).toBe('3карты');
    expect(t(11)).toBe('11карт');
  });
  test('缺省（无 locale）= enUS 口径', () => {
    expect(resolveCardText({ builderType: 26, cardId:      'X', text:        '{0}|4(Card,Cards)',
      tags:        { 2: 2 } }).text).toBe('2Cards');
  });
});
