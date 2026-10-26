import { resolve } from 'node:path';
import { fsSource } from '../src/source-fs';
import { loadPack } from '../src/assets';
import { loadStaticData } from '../src/render-card';
import { compileFramePlan, slotForFixture, type FixtureCard } from '../src/plan';
import { createFontMetrics } from '../src/font';
import { initFreeTypeBackend } from '../src/freetype-metrics';
import { loadFontdef, loadNodeSettingsAlly } from '../src/ubertext';
import { layoutText } from '../src/textlayout';

const root = resolve(import.meta.dir, '../../..');
const dirs = { pack: fsSource(resolve(root, 'assets')), data: fsSource(resolve(root, 'data')) };
await initFreeTypeBackend();
const { tables, wmTables } = loadStaticData(dirs);
const fixture = JSON.parse(dirs.data.text('fixtures/SC_400.json')) as FixtureCard;
const slot = slotForFixture(fixture, key => dirs.pack.has(key));
const pack = loadPack(dirs.pack, slot);
const plan = compileFramePlan(fixture, tables, pack, slot, wmTables);
const text = plan.texts?.find(entry => entry.role === 'desc')?.text;
const settings = loadNodeSettingsAlly(pack).desc;
if (text === undefined || !settings) throw new Error('SC_400 description not resolved');

const localized = settings.fields.m_LocalizedSettings as
  { m_LocaleAdjustments?: Record<string, unknown>[] } | undefined;
const localeRow = (localized?.m_LocaleAdjustments ?? []).find(entry => entry.m_Locale === 9);
const locale = (localeRow ?? {}) as Record<string, number>;
const fontdef = loadFontdef(pack, settings.fontdefName);
const fs = Math.trunc((fontdef.fields.m_FontSizeModifier ?? 1)
  * (locale.m_FontSizeModifier ?? 1) * Number(settings.fields.m_FontSize ?? 0));
const fm = createFontMetrics(pack.src, fontdef.ttfPath, fs);
const layout = layoutText({
  fields:            settings.fields,
  locale,
  fontdef:           fontdef.fields,
  fm,
  text,
  fitLineSpanBounds: slot.includes('-sig') || slot === 'hand-hero',
});
const lines = layout.lines.map(line => line.map(glyph => glyph.ch).join(''));
const expected = ['战吼：再次发射你在', '本局对战中发射过的', '每艘星舰。'];
if (JSON.stringify(lines) !== JSON.stringify(expected)) {
  throw new Error(`SC_400 description wrapping differs from reference: ${JSON.stringify(lines)}`);
}
console.log(`SC_400 hand-hero description wraps to reference lines (${layout.k.toFixed(7)} scale)`);
