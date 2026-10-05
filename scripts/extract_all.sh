#!/bin/bash
# extract_all — 一键导出渲染所需全部素材到资产包 assets/（ADR：assets gitignored，脚本可复现）。
#
# 链序（依赖关系决定，不得调换）：
#   0. data 前置    data/tables.json + data/fixtures/manifest.json —— tracked 冻结数据，
#                   正常随仓库存在；缺失时才提取（两者 manifest 内嵌生成时间戳，
#                   重跑会弄脏 git 工作区，故存在即跳过）
#   1. 字体         extract_fonts.py         ← explore/hs-render/data/fonts_zhcn（py 黄金链冻结数据）
#   2. 原画         extract_fixture_assets.py（读 data/fixtures/manifest.json）
#   3. 类色图集     extract_class_atlases.py （读 data/tables.json 的 colorSwitcher）
#   4. DK 符文 _sm  extract_rune_textures.py （asset_index pid 直取，独立）
#   5. 手牌帧 ×8    extract_frame.py --all   （minion/spell/weapon/hero/location/heropower/
#                                             bg-anomaly/bg-trinket；SLOT_TO_ACTOR_KEY）
#   6. 战棋 spell ×7 extract_spell.py --all  （coin/tier/tech-level 等，SPELLS 表）
#   7. 字形缓存     extract_glyph_cache.py   （必须最后：读 tables + data/fixtures +
#                                             frames/{slot}/manifest + fonts）
#
# 覆盖范围说明：验收路径（--card 渲染，frames/{slot} 形态）所需素材全部由上述步骤产出。
# 包根的 legacy 单帧文件（manifest.json/plan.json/frame_recon.json 等 + GenFX 类共享纹理）
# 是 py 链 export_asset_pack.py 的历史产物，只服务无参冒烟渲染入口；本脚本不删不改已存在的
# 它们，也不会新生成（裸环境如需该入口，另跑 explore/hs-render/local_tools/export_asset_pack.py）。
#
# 前置：游戏安装在 /Applications/Hearthstone（只读）；uv；python 由各脚本 PEP 723 头自管。
# 用法：bash scripts/extract_all.sh
set -euo pipefail
cd "$(dirname "$0")/.."

HS_DATA="/Applications/Hearthstone/Data/OSX"
[ -d "$HS_DATA" ] || { echo "[fail] 找不到游戏数据 $HS_DATA（提取脚本只读它）"; exit 1; }
command -v uv >/dev/null || { echo "[fail] 缺 uv（uv run scripts/<tool>.py）"; exit 1; }

step() { echo ""; echo "=== $1 ==="; }

# ---- 0. data 前置（缺失才提取；存在即跳过以免弄脏 tracked 时间戳）----
if [ ! -f data/tables.json ]; then
  step "0a. data/tables.json（extract_static_tables）"
  uv run scripts/extract_static_tables.py
else
  echo "[skip] data/tables.json 已存在"
fi
if [ ! -f data/fixtures/manifest.json ]; then
  step "0b. data/fixtures/（extract_fixture_data）"
  uv run scripts/extract_fixture_data.py
else
  echo "[skip] data/fixtures/manifest.json 已存在"
fi

step "1/7 字体 fontdefs（extract_fonts）"
uv run scripts/extract_fonts.py

step "2/7 fixture 原画（extract_fixture_assets）"
uv run scripts/extract_fixture_assets.py

step "3/7 类色图集（extract_class_atlases）"
uv run scripts/extract_class_atlases.py

step "4/7 DK 符文 _sm 纹理（extract_rune_textures）"
uv run scripts/extract_rune_textures.py

step "5/7 手牌帧 ×8（extract_frame --all）"
uv run scripts/extract_frame.py --all

step "6/7 战棋 spell 视觉 ×7（extract_spell --all）"
uv run scripts/extract_spell.py --all

step "7/7 字形缓存（extract_glyph_cache，补齐缺失）"
uv run scripts/extract_glyph_cache.py

# ---- legacy 根文件提示（不产出，只提示）----
if [ ! -f assets/manifest.json ]; then
  echo ""
  echo "[note] 包根无 legacy 单帧文件（manifest.json 等）：无参冒烟渲染入口不可用。"
  echo "       如需：uv run explore/hs-render/local_tools/export_asset_pack.py（见脚本头注释）"
fi

echo ""
echo "[done] 资产包就绪：assets/（验收路径 bun run fixtures / --card 渲染可直接跑）"
