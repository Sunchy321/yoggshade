/** DIY 编辑器 —— "卡牌工坊"。
 *  设计原则：只讲游戏语言（卡型/职业/稀有度/费用/攻血/耐久/种族/学派），
 *  不出现任何实现词汇；卡牌预览是视觉中心。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardFields, MetaResponse, PresetInfo, RenderRequest } from './shared.js';
import { loadMetaClient } from './render-client.js';
import { useAutoRender } from './use-auto-render.js';
import { descriptionText } from './description-text.js';

const EMPTY_FIELDS: CardFields = {
  cardType:    4,
  classTag:    12,
  rarity:      1,
  cost:        1,
  attack:      1,
  health:      1,
  armor:       0,
  elite:       false,
  race:        0,
  school:      0,
  mercenary:   false,
  mercRole:    0,
  mercFaction: 0,
  lettuceForm: 0,
  premium:     'NORMAL',
};

const PREMIUM_LABELS = {
  NORMAL: undefined,
  GOLDEN: '金卡',
  SIGNATURE: '异画',
  DIAMOND: '钻石（普通框）',
} as const;

/** 各卡型的字段可见性（游戏语义：英雄显护甲、武器地标显耐久、畸变无费用、法术显学派…）。
 *  佣兵技能（23）：显费用/攻血/学派——攻血是卡面真实显示（含 GetTag-0 补零的引擎怪癖，
 *  未设置即渲染 0/0）；学派驱动描述板 school 网格替换（plan.ts hand-lettuce-ability 分支）。
 *  佣兵本体（随从 + 佣兵勾选）：职业/阵营下拉驱动角色横幅与阵营图标（plan.ts 佣兵段落）。 */
const SPELL_TYPES = new Set([5, 40, 42, 23]);
const HAS_COST = new Set([4, 5, 40, 42, 3, 7, 39, 10, 44, 23]);
const ATTACK_TYPES = new Set([4, 3, 7, 23]);
const HEALTH_TYPES = new Set([4, 7, 23]);
const ARMOR_TYPES = new Set([3]);
const DURABILITY = new Set([7, 39]);
const RACE_TYPES = new Set([4]);
const GEM_TYPES = new Set([4, 5, 40, 42, 3, 7, 39]);

/** 佣兵职业（TAG_LETTUCE_ROLE=1666）官方 zhCN（GLOBAL_ROLE_*，游戏 Strings/zhCN；
 *  游戏 s_roleNames 无 NEUTRAL 条目——4 取同枚举概念的「中立」，s_classNames NEUTRAL 同词）。 */
const MERC_ROLE_LABELS: [number, string][] = [
  [0, '无'], [1, '施法者'], [2, '斗士'], [3, '护卫'], [4, '中立'],
];

/** 佣兵阵营（TAG_LETTUCE_FACTION=2720）官方 zhCN（GLOBAL_MERCENARY_FACTION_*，
 *  游戏 Strings/zhCN；TAG_LETTUCE_FACTION.cs 枚举序 1..7）。 */
const MERC_FACTION_LABELS: [number, string][] = [
  [0, '无'], [1, '联盟'], [2, '部落'], [3, '黑暗帝国'], [4, '探险者'],
  [5, '燃烧军团'], [6, '海盗'], [7, '天灾'],
];

/** 佣兵技能形态（驱动 tag 1676 召唤随从 / 1855 装备的分流，plan.ts slotForCardType）。 */
const LETTUCE_FORM_LABELS: [number, string][] = [
  [0, '施法'], [1, '召唤随从'], [2, '装备'],
];

/** 上传图 → 方形不透明 PNG dataURL。会居中裁剪、铺黑底、限制边长。 */
async function toSquareOpaquePng(file: File, maxSide = 1024): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.max(1, Math.floor(Math.min(bitmap.width, bitmap.height, maxSide)));
  const sx = Math.floor((bitmap.width - side) / 2);
  const sy = Math.floor((bitmap.height - side) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法处理这张图片');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, side, side);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

/** 服务端错误 → 用户能读懂的话（技术细节不出现在界面上） */
function friendlyError(msg: string): string {
  if (msg.includes('正方形')) return '图片需要是正方形的，换一张试试。';
  if (msg.includes('透明')) return '图片不能带透明背景，换一张不透明的吧。';
  if (msg.includes('边长') || msg.includes('不得超过')) return '图片太大了，换一张小一些的（边长 1024 以内）。';
  if (msg.includes('解码') || msg.includes('PNG') || msg.includes('dataURL')) return '这个文件不是能用的图片，换一张吧。';
  if (msg.includes('预设不存在')) return '这张原始卡不见了，重新选一张。';
  if (msg.includes('异画仅适用于')) return '异画目前只能用于带有已移植异画框的原始卡预设。';
  return '生成失败了，请稍后再试。';
}

function Section({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <section className="section">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

interface FieldProps {
  label:    string;
  children: React.ReactNode;
  wide?:    boolean;
}

function Field({ label, children, wide }: FieldProps) {
  return (
    <label className={`field${wide ? ' field-wide' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function Editor() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState('');
  const [presetId, setPresetId] = useState('');
  const [fields, setFields] = useState<CardFields>(EMPTY_FIELDS);
  const [name, setName] = useState('我的卡牌');
  const [portrait, setPortrait] = useState<string | undefined>(undefined);
  const [fileNote, setFileNote] = useState('');
  const [text, setText] = useState('');
  const [composing, setComposing] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [error, setError] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const descRef = useRef<HTMLDivElement | null>(null);
  const pendingDesc = useRef('');
  const descSelection = useRef<Range | null>(null);
  const [formats, setFormats] = useState({ bold: false, italic: false });

  /** 描述富文本（contentEditable，所见即所得）：换行 → <br> 供显示；
   *  提交时转回纯文本换行、只保留加粗/斜体标记——标记语法不出现在界面上。
   *  渲染链 <b>/<i> 独立且可嵌套（CATA_190h "<i><b>兆示</b>…" 先例）。 */
  const toDisplay = (t: string): string => t.replace(/\n/g, '<br>');

  const readDesc = useCallback((): string =>
    descRef.current ? descriptionText(descRef.current.innerHTML) : '', []);

  const body = useMemo<RenderRequest>(() => ({
    ...fields, presetId: presetId || undefined, name, text, portrait,
  }), [fields, presetId, name, text, portrait]);
  const { png, status, error: renderError } = useAutoRender(body, meta !== null, composing);
  const renderMessage = renderError
    ? (renderError as Error).name === 'TtfMissingError'
      ? `暂不支持字符：${(renderError as Error & { char?: string }).char ?? '特殊字符'}`
      : friendlyError((renderError as Error).message)
    : '';
  const statusLabel = { waiting: '待更新', updating: '更新中', updated: '已更新', error: '更新失败' }[status];

  const updateSelection = useCallback(() => {
    const el = descRef.current;
    const selection = window.getSelection();
    if (!el || !selection?.rangeCount || !el.contains(selection.anchorNode)
      || !el.contains(selection.focusNode)) return;
    descSelection.current = selection.getRangeAt(0).cloneRange();
    const bold = document.queryCommandState('bold');
    const italic = document.queryCommandState('italic');
    setFormats(previous => previous.bold === bold && previous.italic === italic
      ? previous
      : { bold, italic });
  }, []);

  // surroundContents 只能叠加标签，重复点击会形成 <b><b>…</b></b>，无法取消。
  // 浏览器编辑命令负责切换选区/光标格式并保留原生撤销记录；强制语义标签，
  // 与渲染协议已有的 <b>/<i> 一致。selectionchange 同步工具栏与键盘快捷键。
  const toggleFormat = useCallback((command: 'bold' | 'italic') => {
    const el = descRef.current;
    const selection = window.getSelection();
    if (!el || !selection) return;
    const range = descSelection.current;
    el.focus();
    if (range && el.contains(range.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(command);
    setText(readDesc());
    updateSelection();
  }, [readDesc, updateSelection]);

  useEffect(() => {
    document.addEventListener('selectionchange', updateSelection);
    return () => document.removeEventListener('selectionchange', updateSelection);
  }, [updateSelection]);

  const pastePlain = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    setText(readDesc());
    updateSelection();
  }, [readDesc, updateSelection]);

  // 描述初始内容：编辑区按 editorKey 重建，重建后写入（避免直接被 React 管理 innerHTML）
  useEffect(() => {
    if (descRef.current) descRef.current.innerHTML = pendingDesc.current;
    descSelection.current = null;
    setFormats({ bold: false, italic: false });
  }, [editorKey]);

  useEffect(() => {
    void (async () => {
      try {
        // 首次装载：预取 /data/**（表枚举 + 预设 fixture），首次出图再取帧纹理/字体
        setMeta(await loadMetaClient());
      } catch (err) {
        setMetaError('工坊没能准备好，请刷新页面再试。');
        console.error(err);
      }
    })();
  }, []);

  /** 预设下拉的选项文案：卡名 +「稀有度 · 职业 · 卡型 · 品质」——光看卡名/内部标签
   *  分不清这张样板是什么（如「无界空宇」是随从、「默认烟测卡」是测试叫法）。
   *  佣兵本体（随从 + 佣兵勾选）卡型位改显「佣兵」——否则与普通随从无法区分。 */
  const presetTitle = useCallback((p: PresetInfo): string => {
    const type = p.fields.cardType === 4 && p.fields.mercenary
      ? '佣兵'
      : meta?.cardTypes.find(t => t.tag === p.fields.cardType)?.label;
    const cls = meta?.classes.find(c => c.tag === p.fields.classTag)?.label;
    const rarity = meta?.rarities.find(r => r.tag === p.fields.rarity)?.label;
    const premium = PREMIUM_LABELS[p.premium];
    const signature = p.signatureAvailable ? '异画可用' : undefined;
    const bits = [rarity, cls, type, premium, signature].filter(Boolean);
    const base = p.name || p.label;
    return bits.length ? `${base}（${bits.join(' · ')}）` : base;
  }, [meta]);

  const applyPreset = useCallback((id: string) => {
    setPresetId(id);
    setError('');
    if (!id) {
      setFields(f => f.premium === 'SIGNATURE' ? { ...f, premium: 'NORMAL' } : f);
      pendingDesc.current = '';
      setText('');
      setEditorKey(k => k + 1);
      setName('我的卡牌');
      return;
    }
    const p = meta?.presets.find(x => x.cardId === id);
    if (!p) return;
    setFields(p.fields);
    setName(p.name || '我的卡牌');
    pendingDesc.current = toDisplay(p.text);
    setText(p.text);
    setEditorKey(k => k + 1);
    setPortrait(undefined);
    setFileNote('');
  }, [meta]);

  const set = <K extends keyof CardFields>(k: K, v: CardFields[K]): void =>
    setFields(f => ({ ...f, [k]: v }));

  const changeType = useCallback((t: number) => {
    setFields(f => ({
      ...f,
      cardType:    t,
      premium: f.premium === 'SIGNATURE'
        && !meta?.presets.some(p => p.cardId === presetId
          && p.signatureAvailable && p.fields.cardType === t)
        ? 'NORMAL'
        : f.premium,
      school:      SPELL_TYPES.has(t) ? f.school : 0,
      // 佣兵字段跟卡型走（同 school 口径）：切走再切回不保留——避免把本体/形态残留
      // 到别的卡型上（1665>0 会把任意卡型抢先分流到 hand-mercenary）
      mercenary:   t === 4 ? f.mercenary : false,
      mercRole:    t === 4 ? f.mercRole : 0,
      mercFaction: t === 4 ? f.mercFaction : 0,
      lettuceForm: t === 23 ? f.lettuceForm : 0,
    }));
  }, [meta, presetId]);

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError('');
    try {
      const dataUrl = await toSquareOpaquePng(file);
      setPortrait(dataUrl);
      setFileNote(file.name);
    } catch (err) {
      setError('这张图片处理不了，换一张吧。');
      console.error(err);
    }
  }, []);

  const clearPortrait = useCallback(() => {
    setPortrait(undefined);
    setFileNote('');
  }, []);

  const t = fields.cardType;
  const signatureAvailable = Boolean(meta?.presets.some(p => p.cardId === presetId
    && p.signatureAvailable && p.fields.cardType === t));
  const downloadName = `${name.trim() || '我的卡牌'}.png`;

  if (metaError) {
    return (
      <div className="shell" data-theme={theme}>
        <p className="error">{metaError}</p>
      </div>
    );
  }

  return (
    <div className="shell" data-theme={theme}>
      <header className="masthead">
        <h1>炉石卡牌工坊</h1>
        <button type="button" className="theme-toggle" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? '浅色' : '深色'}
        </button>
      </header>

      <div className="workbench">
        <div className="bench">
          <Section title="预设">
            <Field label="卡牌" wide>
              <select value={presetId} onChange={e => applyPreset(e.target.value)}>
                <option value="">空白</option>
                {(meta?.presets ?? []).map(p => (
                  <option key={p.cardId} value={p.cardId}>{presetTitle(p)}</option>
                ))}
              </select>
            </Field>
          </Section>

          <Section title="基础信息">
            <div className="field-row">
              <Field label="卡型">
                <select value={t} onChange={e => changeType(Number(e.target.value))}>
                  {(meta?.cardTypes ?? []).map(x => (
                    <option key={x.tag} value={x.tag}>{x.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="卡面品质">
                <select value={fields.premium} onChange={e => set('premium', e.target.value as CardFields['premium'])}>
                  <option value="NORMAL">普通</option>
                  <option value="GOLDEN">金卡</option>
                  <option value="SIGNATURE" disabled={!signatureAvailable}>异画</option>
                  <option value="DIAMOND" disabled>钻石（暂不支持）</option>
                </select>
              </Field>
              <Field label="职业">
                <select value={fields.classTag} onChange={e => set('classTag', Number(e.target.value))}>
                  {(meta?.classes ?? []).map(x => (
                    <option key={x.tag} value={x.tag}>{x.label}</option>
                  ))}
                </select>
              </Field>
              {GEM_TYPES.has(t) && (
                <Field label="稀有度">
                  <select value={fields.rarity} onChange={e => set('rarity', Number(e.target.value))}>
                    {(meta?.rarities ?? []).map(x => (
                      <option key={x.tag} value={x.tag}>{x.label}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <p className="field-note">
              金卡可用于自定义卡；异画仅适用于带有已移植异画框的原始卡预设。缺少专属原画时沿用普通原画。钻石卡需要 3D 渲染，暂不支持。
            </p>
          </Section>

          <Section title="数值">
            <div className="field-row">
              {HAS_COST.has(t) && (
                <Field label="费用">
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={fields.cost}
                    onChange={e => set('cost', Number(e.target.value))}
                  />
                </Field>
              )}
              {ATTACK_TYPES.has(t) && (
                <Field label="攻击">
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={fields.attack}
                    onChange={e => set('attack', Number(e.target.value))}
                  />
                </Field>
              )}
              {HEALTH_TYPES.has(t) && (
                <Field label={DURABILITY.has(t) ? '耐久' : '生命'}>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={fields.health}
                    onChange={e => set('health', Number(e.target.value))}
                  />
                </Field>
              )}
              {ARMOR_TYPES.has(t) && (
                <Field label="护甲">
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={fields.armor}
                    onChange={e => set('armor', Number(e.target.value))}
                  />
                </Field>
              )}
            </div>
            <div className="field-row">
              {RACE_TYPES.has(t) && (
                <Field label="种族">
                  <select value={fields.race} onChange={e => set('race', Number(e.target.value))}>
                    <option value={0}>无</option>
                    {(meta?.races ?? []).map(x => (
                      <option key={x.tag} value={x.tag}>{x.label}</option>
                    ))}
                  </select>
                </Field>
              )}
              {SPELL_TYPES.has(t) && (
                <Field label="学派">
                  <select value={fields.school} onChange={e => set('school', Number(e.target.value))}>
                    <option value={0}>无</option>
                    {(meta?.schools ?? []).map(x => (
                      <option key={x.tag} value={x.tag}>{x.label}</option>
                    ))}
                  </select>
                </Field>
              )}
              {GEM_TYPES.has(t) && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={fields.elite}
                    onChange={e => set('elite', e.target.checked)}
                  />
                  <span>精英龙框</span>
                </label>
              )}
            </div>
            {(t === 4 || t === 23) && (
              <div className="field-row">
                {t === 4 && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={fields.mercenary}
                      onChange={e => set('mercenary', e.target.checked)}
                    />
                    <span>佣兵</span>
                  </label>
                )}
                {t === 4 && fields.mercenary && (
                  <>
                    <Field label="佣兵职业">
                      <select
                        value={fields.mercRole}
                        onChange={e => set('mercRole', Number(e.target.value))}
                      >
                        {MERC_ROLE_LABELS.map(([v, label]) => (
                          <option key={v} value={v}>{label}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="佣兵阵营">
                      <select
                        value={fields.mercFaction}
                        onChange={e => set('mercFaction', Number(e.target.value))}
                      >
                        {MERC_FACTION_LABELS.map(([v, label]) => (
                          <option key={v} value={v}>{label}</option>
                        ))}
                      </select>
                    </Field>
                  </>
                )}
                {t === 23 && (
                  <Field label="形态">
                    <select
                      value={fields.lettuceForm}
                      onChange={e => set('lettuceForm', Number(e.target.value))}
                    >
                      {LETTUCE_FORM_LABELS.map(([v, label]) => (
                        <option key={v} value={v}>{label}</option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            )}
          </Section>

          <Section title="文字">
            <Field label="卡名" wide>
              <input
                type="text"
                value={name}
                maxLength={40}
                onChange={e => setName(e.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                placeholder="给这张卡起个名字"
              />
            </Field>
            <div className="field field-wide">
              <span className="field-label">描述</span>
              <div className="rich-text">
                <div className="text-tools" role="toolbar" aria-label="描述格式">
                  <button
                    type="button"
                    className="text-tool"
                    aria-pressed={formats.bold}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => toggleFormat('bold')}
                  >
                    加粗
                  </button>
                  <button
                    type="button"
                    className="text-tool"
                    aria-pressed={formats.italic}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => toggleFormat('italic')}
                  >
                    斜体
                  </button>
                </div>
                <div
                  key={editorKey}
                  ref={descRef}
                  className="desc-edit"
                  contentEditable
                  suppressContentEditableWarning
                  data-placeholder="战吼：造成 8 点伤害。"
                  onPaste={pastePlain}
                  role="textbox"
                  aria-label="描述"
                  aria-multiline="true"
                  onInput={() => {
                    setText(readDesc());
                    updateSelection();
                  }}
                  onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey
                      && (e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'i')) {
                      e.preventDefault();
                      toggleFormat(e.key.toLowerCase() === 'b' ? 'bold' : 'italic');
                    }
                  }}
                  onCompositionStart={() => setComposing(true)}
                  onCompositionEnd={() => {
                    setText(readDesc());
                    setComposing(false);
                    updateSelection();
                  }}
                />
              </div>
            </div>
          </Section>

          <Section title="原画">
            {portrait
              ? (
                <div className="art-row">
                  <img className="art-thumb" src={portrait} alt="已选择的原画" />
                  <div className="art-info">
                    <span className="art-name">{fileNote}</span>
                    <button type="button" className="link" onClick={clearPortrait}>移除</button>
                  </div>
                </div>
              )
              : (
                <label className="dropzone">
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={e => void onFile(e.target.files?.[0])}
                  />
                  <span className="dropzone-main">上传图片</span>
                </label>
              )}
          </Section>

          {error && <p className="error" role="alert">{error}</p>}
        </div>

        <div className="stage">
          <div className="preview-toolbar">
            <h2>预览</h2>
            <span className={`render-status ${status}`} role="status">{statusLabel}</span>
            {png && status === 'updated'
              ? <a className="save" href={png} download={downloadName}>下载 PNG</a>
              : <button className="save" type="button" disabled>下载 PNG</button>}
          </div>
          <div className="stage-inner">
            <div className="card-slot">
              {png
                ? <img className="card" src={png} alt="你的卡牌" />
                : (
                  <div className="card-empty">
                    <span>{meta ? '预览' : '加载中'}</span>
                  </div>
                )}

            </div>

          </div>
          {renderMessage && <p className="error preview-error" role="alert">{renderMessage}</p>}
        </div>
      </div>

      <footer className="colophon">
        炉石传说及游戏素材版权归暴雪娱乐所有。
      </footer>
    </div>
  );
}
