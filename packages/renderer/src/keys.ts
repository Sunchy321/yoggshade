/** 渲染资产键收集器：fixture → 本次渲染会读取的 pack/** + data/** 键全集。
 *
 * 为什么存在：站点预取此前对 prefab_report/frame_recon 做全量 "file" 正则扫描取
 * 超集（全职业×全卡型帧材质，单次渲染拉 202 文件 ~69.6MB，实测见
 * explore/2026-10-10-web-asset-perf/findings.md）。光栅/宝石/文字各阶段实际读取
 * 以编译后计划为准——本收集器与 renderCard 走同一装配序列（loadStaticData →
 * loadPack → compileFramePlan），再镜像各阶段读取点枚举键，输出读取集的等价集：
 *
 * - 帧光栅（render.ts rasterBucketZbuf）：可见组件（buildRenderList 门控）的
 *   材质 _MainTex/_SecondTex 序列化 file、slotPlan._MainTex_runtime 覆写、
 *   comp.watermark.tex_file；
 * - 肖像（renderPortraitLayer）：肖像槽 _MainTex_runtime + manifest.second_tex
 *   第二通道；
 * - 宝石（gems.ts）：固定 GenFX_clouds03/GenFX_RarityGems + stat_gems[].main_tex_file
 *   （overlay 宝石的纹理由 overlay 层级全量枚举覆盖，是超集）；
 * - 战棋 overlay（renderSpellOverlays）：spells/{key}/ 两 JSON + 层级材质 _MainTex；
 * - 文字（renderTextStage → renderText）：入口 settings 的 fontdefName →
 *   fontdefs.json saved_to 的 TTF（与 renderTextStage 同一套 role/node_path 选取）；
 * - FreeType 后端：fonts/freetype.wasm。
 *
 * 时序约定：frames/{slot}/*.json 与 fontdefs.json 必须已可读（浏览器端先 prime 这批
 * 再调用）；spell overlay JSON 允许缺失（KeyMissingError 被吞、JSON 键照常输出，
 * 纹理留给调用方下一轮收集——固定点两轮收敛）。
 */
import { KeyMissingError } from './source.js';
import { loadPack, loadSpellOverlay, walkWithKey } from './assets.js';
import { buildRenderList } from './render.js';
import {
  slotForCardType,
  compilePlan, compileFramePlan,
  type FixtureCard,
} from './plan.js';
import { loadStaticData, type RenderDirs } from './render-card.js';
import { loadNodeSettingsAlly, nodeSettingsByPath, loadFontdef } from './ubertext.js';

/** loadPack(dirs.pack, slot) 消费的帧 JSON（assets.ts loadPack slot 分支逐一对齐）。 */
const FRAME_JSONS = [
  'manifest.json', 'frame_recon.json', 'meshes.json', 'portrait.json',
  'material_props.json', 'prefab_report.json', 'prefab_ubertext.json', 'curved.json',
] as const;
/** loadStaticData 消费的 data/ 键（render-card.ts read 四连）。 */
const DATA_JSONS = [
  'tables.json',
  'card_meta/card_set_watermarks.json', 'card_meta/card_set_timings.json',
  'card_meta/card_watermark_overrides.json',
] as const;

/** TextureStore.key 镜像：裸文件名落根 textures/（assets.ts TextureStore.key 同语义）。 */
function texKey(ref: string): string {
  return ref.includes('/') ? ref : `textures/${ref}`;
}

export interface AssetKeySet {
  pack: string[];
  data: string[];
}

/** 编译 + 遍历，输出该卡渲染的完整键集。见文件头注释的镜像清单。 */
export function collectRenderAssetKeys(
  input: { fixture: FixtureCard, slot?: string },
  dirs: RenderDirs,
): AssetKeySet {
  const packKeys = new Set<string>();
  const dataKeys = new Set<string>(DATA_JSONS);

  const { tables, wmTables } = loadStaticData(dirs);
  const slot = input.slot ?? slotForCardType(input.fixture.tags);
  const pack = loadPack(dirs.pack, slot);
  for (const f of FRAME_JSONS) packKeys.add(`frames/${slot}/${f}`);
  packKeys.add('fontdefs.json');
  packKeys.add('fonts/freetype.wasm');

  const plan = pack.prefabReport
    ? compileFramePlan(input.fixture, tables, pack, slot, wmTables)
    : compilePlan(input.fixture, tables, pack);

  // 帧光栅节点（exclude=∅ = 主通道∪晚通道的全集；可见性由计划组件门控）
  for (const { materials, comp } of buildRenderList(pack.frameRecon.hierarchy, plan, new Set())) {
    for (const mat of materials) {
      for (const slotName of ['_MainTex', '_SecondTex']) {
        const file = mat?.tex?.[slotName]?.texture?.file;
        if (file) packKeys.add(texKey(file));
      }
    }
    for (const s of comp.material_slots ?? []) {
      if (s._MainTex_runtime?.file) packKeys.add(texKey(s._MainTex_runtime.file));
    }
    if (comp.watermark?.tex_file) packKeys.add(texKey(comp.watermark.tex_file));
  }
  // 肖像第二通道（renderPortraitLayer：pack.manifest.second_tex）
  if (pack.manifest.second_tex) packKeys.add(texKey(pack.manifest.second_tex));

  // 宝石阶段固定键（gems.ts renderStatGems/renderRarityGemWrap）
  packKeys.add('textures/GenFX_clouds03.png');
  packKeys.add('textures/GenFX_RarityGems.png');
  for (const g of plan.stat_gems ?? []) {
    if (g.main_tex_file) packKeys.add(texKey(g.main_tex_file));
  }

  // 战棋 overlay：JSON 键恒发；层级可读则展开材质纹理（浏览器首轮 JSON 未达时
  // 吞 KeyMissingError，纹理键由调用方下一轮收集补齐）
  for (const o of plan.spell_overlays ?? []) {
    const d = `spells/${o.key}`;
    packKeys.add(`${d}/frame_recon.json`);
    packKeys.add(`${d}/meshes.json`);
    try {
      const ov = loadSpellOverlay(dirs.pack, o.key);
      for (const [n] of walkWithKey(ov.hierarchy)) {
        for (const mat of n.renderers?.[0]?.materials ?? []) {
          const file = mat?.tex?.['_MainTex']?.texture?.file;
          if (file) packKeys.add(texKey(file));
        }
      }
    } catch (err) {
      if (!(err instanceof KeyMissingError)) throw err;
    }
  }

  // 文字阶段字体（renderTextStage 的 role → node_path 选取逐行镜像；fontdefs.json
  // 已在键集，loadFontdef 读得到——浏览器首轮 prime 保证）
  const settings = loadNodeSettingsAlly(pack);
  for (const entry of plan.texts ?? []) {
    if (!entry.render || !entry.text) continue;
    let ns = settings[entry.role];
    if (!ns) continue;
    if (entry.node_path) ns = nodeSettingsByPath(pack, entry.node_path) ?? ns;
    const ttf = loadFontdef(pack, ns.fontdefName).ttfPath;
    if (ttf) packKeys.add(ttf);
  }

  // 原画（编译期 has 门控写肖像槽 _MainTex_runtime，已随组件枚举；此处补发缺省键，
  // 调用方按构建清单存在性过滤——DIY 上传无此文件，不取）
  packKeys.add(`portraits/${input.fixture.cardId}.png`);

  return { pack: [...packKeys], data: [...dataKeys] };
}
