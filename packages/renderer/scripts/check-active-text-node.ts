import { resolve } from 'node:path';
import { fsSource } from '../src/source-fs';
import { loadPack } from '../src/assets';
import { loadNodeSettingsAlly } from '../src/ubertext';

const root = resolve(import.meta.dir, '../../..');
const pack = loadPack(fsSource(resolve(root, 'assets')), 'hand-hero-sig14');
const manifest = pack.manifest;
const activeDescPath = `${manifest.frame_root}/${manifest.role_paths!.desc}`;
const activeDescNode = pack.ubertext?.nodes.find(node => node.path === activeDescPath);
if (!activeDescNode) throw new Error(`active description node missing: ${activeDescPath}`);
const selectedDesc = loadNodeSettingsAlly(pack).desc;
for (const field of ['m_Width', 'm_Height', 'm_CharacterSize', 'm_FontSize']) {
  const expected = activeDescNode.fields?.[field];
  const actual = selectedDesc.fields[field];
  if (actual !== expected) {
    throw new Error(`description setting ${field} came from inactive text node: expected ${expected}, got ${actual}`);
  }
}
console.log(`active description node selected: ${activeDescPath}`);
