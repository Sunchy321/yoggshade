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

/**
 * 取景锚（世界 xz，世界单位；缺省原点）。exporter FrameCamera 不对原点取景：相机中心 =
 * TryGetActorFrameBounds 的主体网格（RootObject[/NonQuestObjects]/Mesh）世界包围盒中心
 * （ExporterController.cs:11259 FrameCamera、:11329+ TryGetActorFrameBounds；手牌五帧主体
 * 网格节点不在原点 → 基准图相对原点取景有每帧型常数平移，随从 (−0.019,−0.022)、法术
 * (−0.016,−0.013)、武器 (+0.011,−0.008)、地标背景板节点 (+0.031,+0.060)，×192px/单位即
 * 实测错位，对账见 explore/2026-10-06-l2-offset/findings.md）。plan.frame_center 在
 * main.ts 渲染前写入；本模块 projectX/projectY 与 ubertext.makeScene 是仅有的两个
 * 世界→像素投影出口，所有层（网格/肖像/overlay/宝石/文字）自动跟随。
 */
let anchorX = 0.0;
let anchorZ = 0.0;

export function setFrameAnchor(x: number, z: number): void {
  anchorX = x;
  anchorZ = z;
}

export function getFrameAnchor(): [number, number] {
  return [anchorX, anchorZ];
}

export function projectX(x: number): number {
  return (x - anchorX + HALF_W) * PX_PER_UNIT;
}

export function projectY(z: number): number {
  return (HALF_H - (z - anchorZ)) * PX_PER_UNIT;
}
