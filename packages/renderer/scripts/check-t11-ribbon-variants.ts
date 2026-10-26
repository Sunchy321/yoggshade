import { resolve } from 'node:path';
import { fsSource } from '../src/source-fs';
import { loadPack } from '../src/assets';
import { loadStaticData } from '../src/render-card';
import { compileFramePlan, slotForFixture, type FixtureCard } from '../src/plan';

const root = resolve(import.meta.dir, '../../..');
const dirs = { pack: fsSource(resolve(root, 'assets')), data: fsSource(resolve(root, 'data')) };
const { tables, wmTables } = loadStaticData(dirs);
for (const cardId of ['SC_754', 'CATA_190h']) {
  const fixture = JSON.parse(dirs.data.text(`fixtures/${cardId}.json`)) as FixtureCard;
  const slot = slotForFixture(fixture, key => dirs.pack.has(key));
  const pack = loadPack(dirs.pack, slot);
  const plan = compileFramePlan(fixture, tables, pack, slot, wmTables);
  const normal = plan.components.find(component => component.path.endsWith('/Multiclass_Ribbon_mesh'));
  const signature = plan.components.find(component => component.path.endsWith('/Multiclass_Ribbon_Signature_mesh'));
  if (!normal || normal.visible !== false) {
    throw new Error(`${cardId}: normal ribbon variant should be hidden in ${slot}`);
  }
  if (!signature || signature.visible !== true) {
    throw new Error(`${cardId}: signature ribbon variant should be visible in ${slot}`);
  }
  const tint = signature.material_slots?.[0]?.material_override?._tint_rgb;
  if (!Array.isArray(tint) || tint.length !== 3 || tint.some(channel => channel !== 1)) {
    throw new Error(`${cardId}: signature ribbon red material tint was not neutralized`);
  }
  console.log(`${cardId} ${slot}: signature ribbon selected with neutral base tint`);
}
