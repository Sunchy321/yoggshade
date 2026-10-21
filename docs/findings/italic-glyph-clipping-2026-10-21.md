# 斜体伸出笔画被裁剪（2026-10-21）

用户指出斜体剪切伸出的字形被原矩形裁掉。本次修改仅修复位图剪切写入范围，不更换斜体实现路线、系数、advance、排版或校准。用户已于2026-10-21目检确认修复有效。

## 根因与证据

`packages/renderer/src/freetype-metrics.ts` 的 `applyShear` 已按 `minY/maxY` 分配左右 padding，更新 `minX/maxX`，却仍只遍历原 `mask.w` 列。逆采样后的字形超出该窗口时，扩出的列永远为0。矩形缓冲可容纳完整倾斜字形，实际错误是未填满倾斜后包围盒。

修改前已执行 `bun explore/2026-10-21-italic-clipping/repro.ts`：一行4个全覆盖像素、shear=0.5、maxY=4，扩宽至6列但结果为 `[0,0.25,1,1,0,0]`，总覆盖量4→2.25，断言失败。这是实际私有剪切函数的最小调用，无其它渲染阶段干扰。

修改为遍历输出宽度 `nw`，源坐标取 `x−leftPad−dx`。修后为 `[0,0.25,1,1,1,0.75]`，总覆盖量4。负基线行的左侧伸出也验证总覆盖量4。

上游引擎参考：Angelia `lab/2026-10-17-text-rdc-align/findings/desc-atlas-canon.md` §4（UberTextMgr.cs:72-74，Normal/Italic各自字形和bearing）。本问题是TS对正体位图离线剪切的实现bug，引擎请求独立Italic字形，不经历这个错误循环；本次修复不宣称bitmap剪切已达到引擎Italic逐像素一致。

## 验证

- 最小复现：修前红、修后绿，左右伸出均保留。
- `bun run typecheck`、`bunx eslint packages/renderer/src/freetype-metrics.ts`、`git diff --check` 通过。
- 同输入前后重渲：三张斜体卡和一张非斜体对照。before由实验包装器重现旧写窗口，after为新实现；每个变体独立进程，避免模块字形缓存污染A/B。
- 第一轮同进程A/B误复用before字形缓存，产物保留在output/，不作结论；有效产物为output-v2/。

本仓冻结reference L2整卡MAE：

| 卡 | before | after |
|---|---:|---:|
| BG30_802 | 5.964 | 5.924 |
| ETC_210 | 5.506 | 5.435 |
| CATA_190h | 4.799 | 4.762 |
| DMF_709（非斜体对照） | 9.853 | 9.853 |

DMF_709修前后PNG逐字节相同。分区存在重叠，ETC_210非文字掩码读数3.939→3.937并不表示改了非文字路径。未跑全量L2；此表只证明所列样本改善，不宣称全部渲染已与游戏一致。

实验脚本和三列局部图：`explore/2026-10-21-italic-clipping/`。局部图为ETC_210描述区，左=reference、中=before、右=after；最近邻2倍展示，仅供用户视觉确认。
