/**
 * Exporter 正交投影（FrameCamera 对译；2026-10-04 用户裁定对齐 exporter 基准口径）：
 * orthographicSize=2（半高 2 → 全高 4 世界单位）+ aspect 2:3 → 出图 512×768、192 px/世界单位。
 * 出处：exporter ExporterController.cs:659-660（exportWidth/Height 默认 512×768）、:7440
 * （RenderTexture.GetTemporary 同尺寸）、FrameCamera :11027（orthoSize=2.0）及
 * :11021-11025（aspect=2:3 取景注释）；协议 schema style card.hand.v1 = 512×768 +
 * transparentBackground。L2 验收 = 与 exporter 基准图（reference/，512×768）同尺寸对比。
 * 前口径为游戏内 SnapshotCamera 的 512×707（176.75 px/单位；py scene_compiler：AlphaTool.cs:
 * 285-287）——同一张卡内容比 exporter 口径小 192/176.75−1 ≈ 8.6%，2026-10-04 起退役。
 * 世界 (x,y,z)：px ← x，py ← z；y 是深度轴（越大越近相机）。
 */
export const PX_PER_UNIT = 768.0 / 4.0;
export const HALF_H = 2.0;
export const HALF_W = (2.0 * 512.0) / 768.0;
export const SIZE: [number, number] = [512, 768];

export function projectX(x: number): number {
  return (x + HALF_W) * PX_PER_UNIT;
}

export function projectY(z: number): number {
  return (HALF_H - z) * PX_PER_UNIT;
}
