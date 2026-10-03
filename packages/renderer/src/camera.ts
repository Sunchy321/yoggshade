/**
 * SnapshotCamera 正交投影（scene_compiler 自然映射，零手调）：
 * orthographicSize=2（半高 2 → 全高 4 世界单位贴满 707px），出图 512×707。
 * 世界 (x,y,z)：px ← x，py ← z；y 是深度轴（越大越近相机）。
 */
export const PX_PER_UNIT = 707.0 / 4.0;
export const HALF_H = 2.0;
export const HALF_W = (2.0 * 512.0) / 707.0;
export const SIZE: [number, number] = [512, 707];

export function projectX(x: number): number {
  return (x + HALF_W) * PX_PER_UNIT;
}

export function projectY(z: number): number {
  return (HALF_H - z) * PX_PER_UNIT;
}
