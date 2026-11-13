// Import only reviewed real vehicles from a pinned, attributed source. No paid API,
// runtime third-party URLs, inferred generation ranges, or generic substitutes.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const revision = '2d18dfd9db96bbf0d9cffa949deaf7f571388cbf';
const base = `https://raw.githubusercontent.com/pedrosoandre/carros/${revision}`;
// The upstream year ranges are sometimes incorrect. These identities are based on
// the individual artist's source title, not the upstream blanket range.
const reviewed = [
  { sourceId: 'toyota-prius', key: 'toyota-prius-2012', make: 'Toyota', model: 'Prius', years: [2012, 2012] },
  { sourceId: 'honda-fit', key: 'honda-fit-2016', make: 'Honda', model: 'Fit', years: [2016, 2016] },
  { sourceId: 'nissan-versa', key: 'nissan-versa-2010', make: 'Nissan', model: 'Versa', years: [2010, 2010] },
  { sourceId: 'hyundai-santa-fe', key: 'hyundai-santa-fe-2020', make: 'Hyundai', model: 'Santa Fe', years: [2020, 2020] },
  { sourceId: 'kia-soul', key: 'kia-soul-2023', make: 'Kia', model: 'Soul', years: [2023, 2023] },
  { sourceId: 'fiat-stilo', key: 'fiat-stilo-2001-2010', make: 'Fiat', model: 'Stilo', years: [2001, 2010] },
];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function download(path) {
  const response = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Source ${path}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 10 * 1024 * 1024) throw new Error(`Source ${path} exceeds import budget`);
  return bytes;
}
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const catalog = JSON.parse(Buffer.from(await download('cars.json')).toString());
await mkdir('public/vehicle-visuals', { recursive: true });
await mkdir('docs/vehicle-visuals', { recursive: true });
const rows = [];
for (const entry of reviewed) {
  const source = catalog.cars.find((car) => car.id === entry.sourceId);
  if (!source || source.credit.license !== 'CC Attribution') throw new Error(`Review license: ${entry.sourceId}`);
  const original = await download(`assets/${source.file}`);
  const document = await io.readBinary(original);
  const assetCredit = document.getRoot().getAsset().extras;
  if (!String(assetCredit?.license).includes('CC-BY-4.0')) throw new Error(`GLB lacks expected attribution: ${entry.key}`);
  // Decode at import time so the browser does not fetch third-party decoders or
  // need a weaker CSP to compile WASM. Keep portable quantized mesh data.
  for (const ext of document.getRoot().listExtensionsUsed()) {
    if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  }
  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const png = await sharp(image).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
    texture.setImage(new Uint8Array(png)).setMimeType('image/png');
  }
  const bytes = await io.writeBinary(document);
  await writeFile(`public/vehicle-visuals/${entry.key}.glb`, bytes);
  rows.push({
    key: entry.key, make: entry.make, model: entry.model, modelAliases: [], yearFrom: entry.years[0], yearTo: entry.years[1],
    modelPath: `/vehicle-visuals/${entry.key}.glb`, posterPath: `/vehicle-visuals/${entry.key}.png`,
    sourceAsset: `${base}/assets/${source.file}`, sourceRevision: revision, sourceSha256: sha(original), modelSha256: sha(bytes), modelBytes: bytes.length,
    credit: { author: source.credit.author, sourceUrl: String(assetCredit.source || source.credit.sourceUrl).replace('/3d-models/none-', '/3d-models/'), license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', changes: 'Upstream web optimization; Xpeed decoded mesh compression and resized textures to 512px; transparent poster rendered from this model.' },
  });
  console.log(`${entry.key}: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`);
}
await writeFile('docs/vehicle-visuals/catalog.json', JSON.stringify({ repository: 'https://github.com/pedrosoandre/carros', revision, visuals: rows }, null, 2) + '\n');
for (const file of ['LICENSE', 'LICENSE-3D-MODELS.md']) await writeFile(`docs/vehicle-visuals/UPSTREAM-${file}`, await download(file));
const values = rows.map((r) => `(${[r.key, r.make, r.model].map(quote).join(',')},'{}',${r.yearFrom},${r.yearTo},${[r.modelPath,r.posterPath,r.credit.author,r.credit.sourceUrl,r.credit.license,r.credit.licenseUrl,r.credit.changes,r.sourceRevision,r.modelSha256].map(quote).join(',')})`).join(',\n');
await writeFile('supabase/migrations/20261113072100_vehicle_visuals_seed.sql', `-- Generated by scripts/import-vehicle-visuals.mjs. Credits: docs/vehicle-visuals/catalog.json.\nINSERT INTO public.vehicle_visuals (key,make,model,model_aliases,year_from,year_to,model_path,poster_path,author,source_url,license,license_url,changes,source_revision,model_sha256) VALUES\n${values}\nON CONFLICT (key) DO NOTHING;\n`);
