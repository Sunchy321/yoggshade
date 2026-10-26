import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { renderCard } from '../src/render-card';
import { fsSource } from '../src/source-fs';
import type { FixtureCard } from '../src/plan';

const root = resolve(import.meta.dir, '../../..');
const dirs = { pack: fsSource(resolve(root, 'assets')), data: fsSource(resolve(root, 'data')) };
const fixture = JSON.parse(dirs.data.text('fixtures/CATA_190h.json')) as FixtureCard;
const rendered = PNG.sync.read(Buffer.from((await renderCard({ fixture, stage: 'p0' }, dirs)).png));
const reference = PNG.sync.read(readFileSync(resolve(root, 'reference/CATA_190h.png')));

// The top orb of the Deathwing multiclass badge overlaps the portrait window. It must remain
// in front of the signature portrait, matching the exporter reference rather than being hidden
// by the offline portrait pass. The pixel crop is the upper orb only, excluding the plaque/frame.
const roi = { x0: 244, y0: 625, x1: 264, y1: 640 };
let sum = 0, count = 0, referenceBright = 0, renderedBright = 0, maskMismatches = 0;
for (let y = roi.y0; y < roi.y1; y++) for (let x = roi.x0; x < roi.x1; x++) {
  const i = (y * reference.width + x) * 4;
  const ra = reference.data[i + 3], oa = rendered.data[i + 3];
  const rr = Math.trunc(reference.data[i] * ra / 255);
  const rg = Math.trunc(reference.data[i + 1] * ra / 255);
  const rb = Math.trunc(reference.data[i + 2] * ra / 255);
  const or = Math.trunc(rendered.data[i] * oa / 255);
  const og = Math.trunc(rendered.data[i + 1] * oa / 255);
  const ob = Math.trunc(rendered.data[i + 2] * oa / 255);
  sum += Math.max(Math.abs(rr - or), Math.abs(rg - og), Math.abs(rb - ob));
  count++;
  const referenceOrb = rr > 170 && rg > 145 && rb > 85;
  const renderedOrb = or > 170 && og > 145 && ob > 85;
  if (referenceOrb) referenceBright++;
  if (renderedOrb) renderedBright++;
  if (referenceOrb !== renderedOrb) maskMismatches++;
}
const mae = sum / count;
console.log(`CATA_190h upper multiclass orb: bright mask ${renderedBright}/${referenceBright}, mismatched pixels=${maskMismatches}, RGB MAE=${mae.toFixed(3)}`);
if (maskMismatches > 0) throw new Error('CATA_190h signature portrait occludes the upper multiclass orb');
