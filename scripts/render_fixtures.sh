#!/bin/bash
# 渲染全部 fixture 卡到 out/fixtures/{CARD_ID}.png（M1 口径：随从帧 + normal 品质；
# 非随从卡型在专属帧落地前先用随从帧渲染，作为回归基线，不作正确性验收）。
set -e
cd "$(dirname "$0")/.."
mkdir -p out/fixtures
for id in $(bun -e '
const m = require("./data/fixtures/manifest.json");
console.log(m.presets.map((p) => p.cardId).join("\n"));
'); do
  echo "=== $id ==="
  bun packages/renderer/src/main.ts --card "$id" --out "out/fixtures/$id.png" || echo "[fail] $id"
done
echo "[done] out/fixtures/"
