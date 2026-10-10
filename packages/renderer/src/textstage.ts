/** 文字层装配：plan.texts → uber_text 层 → PIL alpha_composite 口径合成到 RGB buffer。
 *  alpha：透明背景口径的覆盖率平面，文字 over 累加（见合成循环注）。 */
import { SIZE } from './camera.js';
import { makeScene, loadNodeSettingsAlly, nodeSettingsByPath, renderText } from './ubertext.js';
import type { AssetPack } from './types.js';

export async function renderTextStage(rgb: Float64Array, pack: AssetPack, alpha?: Float64Array): Promise<void> {
  const scene = makeScene();
  const settings = loadNodeSettingsAlly(pack);
  const W = SIZE[0], H = SIZE[1];

  for (const entry of pack.plan!.texts ?? []) {
    if (!entry.render || !entry.text) continue;
    let ns = settings[entry.role];
    if (!ns) continue;
    // 战棋 alternate-cost：费用文本挪到铸币位（Actor.cs:562/6454；delta 由 plan 计算）
    const delta = entry.world_delta;
    if (delta) ns = { ...ns, worldPos: [ns.worldPos[0] + delta[0], ns.worldPos[1] + delta[1], ns.worldPos[2] + delta[2]] };
    // 换节点渲染（UpdateRace 多族 → Multi_RaceUberText，按其自有盒/锚点）
    if (entry.node_path) ns = nodeSettingsByPath(pack, entry.node_path) ?? ns;
    const layer = renderText(pack, entry.text, ns, scene, [0.0, 0.0],
      entry.role === 'name' ? pack.curved : undefined);
    // DEBUG_LAYER 仅 CLI 调试用（浏览器无 process，条件恒假——ADR-0002）
    if (globalThis.process?.env.DEBUG_LAYER === entry.role) {
      // encodePng（写盘）在 png-file.ts（node:fs 收容，ADR-0002 自 image.ts 拆出）：
      // 变量 + @vite-ignore 引入，不进浏览器依赖图
      const pfMod = './png-file.js';
      const { encodePng } = await import(/* @vite-ignore */ pfMod);
      const fsMod = 'node:fs';
      const { mkdirSync } = await import(/* @vite-ignore */ fsMod);
      mkdirSync('out', { recursive: true });
      const u8 = new Uint8Array(layer.w * layer.h * 4);
      for (let i = 0; i < u8.length; i++) u8[i] = Math.trunc(layer.data[i] * 255);
      encodePng(`out/layer_${entry.role}_ts.png`, layer.w, layer.h, u8);
    }
    // base over：out = l.rgb·l.a + base·(1−l.a)；sa=0 的像素 base 不变（PIL 语义），
    // 仅对被文字覆盖的像素做 uint8 舍入，避免全图逐层重取整漂移。
    // alpha 平面同步 over 累加（a' = sa + a·(1−sa)）：费用数字画在凸出卡框的宝石上，
    // 透明背景输出下文字自身覆盖率必须入 alpha，否则凸出部分的数字被抠掉
    for (let i = 0; i < W * H; i++) {
      const sa = layer.data[i * 4 + 3];
      if (sa <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = layer.data[i * 4 + c] * sa + rgb[i * 3 + c] * (1 - sa);
        rgb[i * 3 + c] = Math.round(Math.min(Math.max(v, 0), 1) * 255) / 255;
      }
      if (alpha) alpha[i] = sa + alpha[i] * (1 - sa);
    }
  }
}
