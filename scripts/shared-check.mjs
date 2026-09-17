/**
 * The files in src/shared are mirrored byte-for-byte between timekeeper-online
 * and watch-store-crm. This checks they still match MANIFEST.json, so an edit
 * made in one app and forgotten in the other fails the build rather than
 * quietly letting the two disagree about somebody's hours.
 *
 *   node scripts/shared-check.mjs          verify
 *   node scripts/shared-check.mjs --write  record the current files
 *
 * The two repos are in step when they print the same foundation hash.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared');
const manifestPath = join(root, 'MANIFEST.json');
const write = process.argv.includes('--write');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/* Every .ts under src/shared, __tests__ included. It used to be a flat listing,
   which quietly left the checks out of the very guard meant to stop the two
   copies drifting — a rule could be proved in one app and not the other and
   nothing would say so. */
function everyFile(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return everyFile(full);
    return e.name.endsWith('.ts') ? [relative(root, full).split(sep).join('/')] : [];
  });
}
const files = everyFile(root).sort();
const hashes = Object.fromEntries(files.map((f) => [f, sha(readFileSync(join(root, f)))]));
const foundation = sha(JSON.stringify(hashes));

if (write) {
  writeFileSync(manifestPath, `${JSON.stringify({ foundation, files: hashes }, null, 2)}\n`);
  console.log(`shared: recorded ${files.length} files, foundation ${foundation}`);
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  console.error('shared: MANIFEST.json is missing. Run `npm run shared:hash`.');
  process.exit(1);
}

const drifted = files.filter((f) => manifest.files[f] !== hashes[f]);
const missing = Object.keys(manifest.files).filter((f) => !files.includes(f));
const added = files.filter((f) => !(f in manifest.files));

if (drifted.length || missing.length || added.length) {
  console.error('shared: these files no longer match MANIFEST.json —');
  for (const f of drifted) console.error(`  changed  ${f}`);
  for (const f of missing) console.error(`  removed  ${f}`);
  for (const f of added) console.error(`  new      ${f}`);
  console.error('\nIf the change is intended, run `npm run shared:hash` and copy');
  console.error('src/shared/ into the other app so both stay in step.');
  process.exit(1);
}

console.log(`shared: ${files.length} files in step, foundation ${foundation}`);
