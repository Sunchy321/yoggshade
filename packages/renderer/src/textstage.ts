/** 文字层装配：plan.texts → uber_text 层 → PIL alpha_composite 口径合成到 RGB buffer。
 *  alpha：透明背景口径的覆盖率平面，文字 over 累加（见合成循环注）。 */
import { SIZE } from './camera.js';
import { makeScene, loadNodeSettingsAlly, nodeSettingsByPath, renderText } from './ubertext.js';
import type { AssetPack } from './types.js';

export async function renderTextStage(rgb: Float64Array, pack: AssetPack, alpha?: Float64Array): Promise<void> {
  const scene = makeScene();
  const settings = loadNodeSettingsAlly(pack);
  const W = SIZE[0], H = SIZE[1];

  // desc 垂直校准（2026-10-10，用户批准手动校准）：desc 文本块整体偏上，行剖面亚像素
  // 互相关实测需 +1.25~+1.71px 下移（10 卡 × 5 帧型：随从/法术/英雄/英雄技能/战棋饰品，
  // explore/2026-10-10-text-offset/findings.md §4A + px4b.ts；卡内各行紧致一致 = 真实
  // 平移，非字形形状差）。TS 布局数学已对齐 Angeila 垂直模型 v2（<0.1px），残差来自
  // Unity 原生 TextGenerator（Populate_Internal 为 native extern，无 .NET 源码）的
  // MiddleCenter 垂直锚定行为，行为拟合路线不可推导——本常数即 Angeila 同款"唯一非推导
  // 数"做法（其 (6,-4.5) 基座校准，text-rendering-pipeline.md）。逐卡散布 ±0.25px 是该
  // 路线的地板。常数取 1.55 = 六卡 desc 区 MAE 扫描谷底（1.25/1.35/1.45/1.50/1.55/1.60/1.65
  // → 总和 25.13/23.73/22.86/22.10/21.91/22.46/23.60，explore/2026-10-10-text-offset）。
  // YOGGSHADE_DESC_CALIB 可覆盖（CLI/标定用；浏览器无 process 取默认）。
  const CALIB: Partial<Record<string, [number, number]>> = {
    desc: [0.0, Number(globalThis.process?.env.YOGGSHADE_DESC_CALIB ?? 1.55)],
    // cost 数字校准（2026-10-10，同 desc 方法论）：全量 26 张已锚定卡费用区白墨剖面
    // 亚像素互相关一致偏左上（dx +0.35~+0.95 / dy +0.05~+0.75，与位数无关；
    // explore/2026-10-10-text-offset px5.ts）。未锚定特殊帧（佣兵/事件/钻石 ±3px 无曲率）
    // 与 BG 系（金币数字白墨阈值不适用）不在本校准适用域。YOGGSHADE_COST_CALIB="x,y" 覆盖。
    cost: [
      Number(globalThis.process?.env.YOGGSHADE_COST_CALIB?.split(',')[0] ?? 0.7),
      Number(globalThis.process?.env.YOGGSHADE_COST_CALIB?.split(',')[1] ?? 0.35),
    ],
    // attack/health 数字校准（2026-10-10，同上）：px6.ts 全量普查——attack 一致偏左上
    // （dx +0.65~0.95 / dy +0.05~0.70）、health（dx +0.05~0.90 / dy +0.05~0.65），扫描
    // 定值见各常数。YOGGSHADE_ATTACK_CALIB / YOGGSHADE_HEALTH_CALIB="x,y" 覆盖。
    attack: [
      Number(globalThis.process?.env.YOGGSHADE_ATTACK_CALIB?.split(',')[0] ?? 0.75),
      Number(globalThis.process?.env.YOGGSHADE_ATTACK_CALIB?.split(',')[1] ?? 0.45),
    ],
    health: [
      Number(globalThis.process?.env.YOGGSHADE_HEALTH_CALIB?.split(',')[0] ?? 0.75),
      Number(globalThis.process?.env.YOGGSHADE_HEALTH_CALIB?.split(',')[1] ?? 0.35),
    ],
  };

  for (const entry of pack.plan!.texts ?? []) {
    if (!entry.render || !entry.text) continue;
    let ns = settings[entry.role];
    if (!ns) continue;
    // 战棋 alternate-cost：费用文本挪到铸币位（Actor.cs:562/6454；delta 由 plan 计算）
    const delta = entry.world_delta;
    if (delta) ns = { ...ns, worldPos: [ns.worldPos[0] + delta[0], ns.worldPos[1] + delta[1], ns.worldPos[2] + delta[2]] };
    // 换节点渲染（UpdateRace 多族 → Multi_RaceUberText，按其自有盒/锚点）
    if (entry.node_path) ns = nodeSettingsByPath(pack, entry.node_path) ?? ns;
    const layer = renderText(pack, entry.text, ns, scene, CALIB[entry.role] ?? [0.0, 0.0],
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
