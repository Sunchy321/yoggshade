/** 文字层装配：plan.texts → uber_text 层 → PIL alpha_composite 口径合成到 RGB buffer。 */
import { SIZE } from "./camera.js";
import { makeScene, loadNodeSettingsAlly, renderText } from "./ubertext.js";
import type { AssetPack } from "./types.js";

export async function renderTextStage(rgb: Float64Array, pack: AssetPack): Promise<void> {
  const scene = makeScene();
  const settings = loadNodeSettingsAlly(pack);
  const W = SIZE[0], H = SIZE[1];

  for (const entry of pack.plan.texts ?? []) {
    if (!entry.render || !entry.text) continue;
    const ns = settings[entry.role];
    if (!ns) continue;
    const layer = renderText(pack, entry.text, ns, scene, [0.0, 0.0],
      entry.role === "name" ? pack.curved : undefined);
    if (process.env.DEBUG_LAYER === entry.role) {
      const { encodePng } = await import("./image.js");
      const { mkdirSync } = await import("node:fs");
      mkdirSync("out", { recursive: true });
      const u8 = new Uint8Array(layer.w * layer.h * 4);
      for (let i = 0; i < u8.length; i++) u8[i] = Math.trunc(layer.data[i] * 255);
      encodePng(`out/layer_${entry.role}_ts.png`, layer.w, layer.h, u8);
    }
    // base（a=255）over：out = l.rgb·l.a + base·(1−l.a)；sa=0 的像素 base 不变（PIL 语义），
    // 仅对被文字覆盖的像素做 uint8 舍入，避免全图逐层重取整漂移
    for (let i = 0; i < W * H; i++) {
      const sa = layer.data[i * 4 + 3];
      if (sa <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = layer.data[i * 4 + c] * sa + rgb[i * 3 + c] * (1 - sa);
        rgb[i * 3 + c] = Math.round(Math.min(Math.max(v, 0), 1) * 255) / 255;
      }
    }
  }
}
