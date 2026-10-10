/** DIY 编辑器 —— "卡牌工坊"。
 *  设计原则：只讲游戏语言（卡型/职业/稀有度/费用/攻血/耐久/种族/学派），
 *  不出现任何实现词汇；卡牌预览是视觉中心。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardFields, MetaResponse, RenderRequest } from './shared.js';

const EMPTY_FIELDS: CardFields = {
  cardType: 4,
  classTag: 12,
  rarity:   1,
  cost:     1,
  attack:   1,
  health:   1,
  armor:    0,
  elite:    false,
  race:     0,
  school:   0,
};

/** 各卡型的字段可见性（游戏语义：英雄显护甲、武器地标显耐久、畸变无费用、法术显学派…） */
const SPELL_TYPES = new Set([5, 40, 42]);
const HAS_COST = new Set([4, 5, 40, 42, 3, 7, 39, 10, 44]);
const ATTACK_TYPES = new Set([4, 3, 7]);
const HEALTH_TYPES = new Set([4, 7]);
const ARMOR_TYPES = new Set([3]);
const DURABILITY = new Set([7, 39]);
const RACE_TYPES = new Set([4]);
const GEM_TYPES = new Set([4, 5, 40, 42, 3, 7, 39]);

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
  const [png, setPng] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const pngRef = useRef<string | undefined>(undefined);
  const descRef = useRef<HTMLDivElement | null>(null);
  const pendingDesc = useRef('');

  /** 描述富文本（contentEditable，所见即所得）：换行 → <br> 供显示；
   *  提交时转回纯文本换行、只保留加粗/斜体标记——标记语法不出现在界面上。
   *  渲染链 <b>/<i> 独立且可嵌套（CATA_190h "<i><b>兆示</b>…" 先例）。 */
  const toDisplay = (t: string): string => t.replace(/\n/g, '<br>');

  const htmlToText = (el: HTMLElement): string =>
    el.innerHTML
      .replace(/<div>/gi, '\n')
      .replace(/<\/div>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(?!\/?(?:b|i)>)[^>]+>/gi, '');

  const readDesc = useCallback((): string =>
    descRef.current ? htmlToText(descRef.current) : '', []);

  /** 把选中的描述文字套进 <b>/<i>（游戏里的关键词/斜体样式；实现细节不出现在界面上）。 */
  const wrapSelection = useCallback((tag: 'b' | 'i') => {
    const el = descRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed || !el.contains(range.commonAncestorContainer)) return;
    try {
      const el2 = document.createElement(tag);
      range.surroundContents(el2);
    } catch {
      document.execCommand(tag === 'b' ? 'bold' : 'italic');
    }
  }, []);

  const pastePlain = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  }, []);

  // 描述初始内容：编辑区按 editorKey 重建，重建后写入（避免直接被 React 管理 innerHTML）
  useEffect(() => {
    if (descRef.current) descRef.current.innerHTML = pendingDesc.current;
  }, [editorKey]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/meta');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setMeta(await res.json() as MetaResponse);
      } catch (err) {
        setMetaError('工坊没能准备好，请刷新页面再试。');
        console.error(err);
      }
    })();
  }, []);

  const preset = useMemo(
    () => meta?.presets.find(p => p.cardId === presetId),
    [meta, presetId],
  );

  const applyPreset = useCallback((id: string) => {
    setPresetId(id);
    setError('');
    if (!id) {
      pendingDesc.current = '';
      setEditorKey(k => k + 1);
      setName('我的卡牌');
      return;
    }
    const p = meta?.presets.find(x => x.cardId === id);
    if (!p) return;
    setFields(p.fields);
    setName(p.name || '我的卡牌');
    pendingDesc.current = toDisplay(p.text);
    setEditorKey(k => k + 1);
    setPortrait(undefined);
    setFileNote('');
  }, [meta]);

  const set = <K extends keyof CardFields>(k: K, v: CardFields[K]): void =>
    setFields(f => ({ ...f, [k]: v }));

  const changeType = useCallback((t: number) => {
    setFields(f => ({
      ...f,
      cardType: t,
      school:   SPELL_TYPES.has(t) ? f.school : 0,
    }));
  }, []);

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

  const render = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const body: RenderRequest = {
        ...fields, presetId: presetId || undefined, name, text: readDesc(), portrait,
      };
      const res = await fetch('/api/render', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({ error: '' })) as { error?: string };
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (pngRef.current) URL.revokeObjectURL(pngRef.current);
      pngRef.current = url;
      setPng(url);
    } catch (err) {
      setError(friendlyError((err as Error).message));
    } finally {
      setBusy(false);
    }
  }, [busy, fields, name, portrait, presetId, readDesc]);

  const t = fields.cardType;
  const downloadName = `${name.trim() || '我的卡牌'}.png`;

  if (metaError) {
    return (
      <div className="shell">
        <p className="error">{metaError}</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="masthead">
        <h1>炉石卡牌工坊</h1>
        <p>写下你的卡牌，看它铸成卡面。</p>
      </header>

      <form
        className="workbench"
        onSubmit={e => {
          e.preventDefault();
          void render();
        }}
      >
        <div className="bench">
          <Section title="从一张真实的卡开始">
            <Field label="灵感" wide>
              <select value={presetId} onChange={e => applyPreset(e.target.value)}>
                <option value="">从空白开始</option>
                {(meta?.presets ?? []).map(p => (
                  <option key={p.cardId} value={p.cardId}>{p.name || p.label}</option>
                ))}
              </select>
            </Field>
          </Section>

          <Section title="这张卡是什么">
            <div className="field-row">
              <Field label="卡型">
                <select value={t} onChange={e => changeType(Number(e.target.value))}>
                  {(meta?.cardTypes ?? []).map(x => (
                    <option key={x.tag} value={x.tag}>{x.label}</option>
                  ))}
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
          </Section>

          <Section title="文字">
            <Field label="卡名" wide>
              <input
                type="text"
                value={name}
                maxLength={40}
                onChange={e => setName(e.target.value)}
                placeholder="给这张卡起个名字"
              />
            </Field>
            <Field label="描述" wide>
              <div
                key={editorKey}
                ref={descRef}
                className="desc-edit"
                contentEditable
                suppressContentEditableWarning
                data-placeholder="战吼：造成 8 点伤害。"
                onPaste={pastePlain}
              />
            </Field>
            <div className="text-tools">
              <button type="button" className="text-tool" onClick={() => wrapSelection('b')}>
                加粗
              </button>
              <button type="button" className="text-tool" onClick={() => wrapSelection('i')}>
                斜体
              </button>
              <span className="tip">先选中一句话，再选加粗或斜体，它可以像游戏里那样突出显示。</span>
            </div>
          </Section>

          <Section title="画作">
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
                  <span className="dropzone-main">选择一张图片</span>
                  <span className="dropzone-sub">
                    {preset?.hasPortrait ? '不选的话，就用原卡的画' : '会自动裁剪为正方形'}
                  </span>
                </label>
              )}
            {preset?.hasPortrait && portrait && (
              <p className="tip">已替换原卡画作。</p>
            )}
          </Section>

          <button className="forge" type="submit" disabled={busy}>
            {busy ? '铸造中…' : '生成卡牌'}
          </button>
          {error && <p className="error">{error}</p>}
        </div>

        <div className="stage">
          <div className="stage-inner">
            <div className={`card-slot${busy ? ' is-busy' : ''}`}>
              {png
                ? <img key={png} className="card" src={png} alt="你的卡牌" />
                : (
                  <div className="card-empty">
                    <span>
                      你的卡牌
                      <br />
                      会出现在这里
                    </span>
                  </div>
                )}
              {busy && (
                <div className="casting">
                  <span className="casting-ring" />
                  <span>铸造中</span>
                </div>
              )}
            </div>
            {png && (
              <a className="save" href={png} download={downloadName}>保存图片</a>
            )}
          </div>
        </div>
      </form>

      <footer className="colophon">
        本站是非官方的粉丝工具，与暴雪娱乐无关。炉石传说及全部游戏素材的版权归暴雪娱乐所有，卡图仅供个人娱乐。
      </footer>
    </div>
  );
}
