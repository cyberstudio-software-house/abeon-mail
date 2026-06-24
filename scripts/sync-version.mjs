import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CARGO_PACKAGE_VERSION = /(\[(?:workspace\.)?package\][^[]*?\nversion\s*=\s*")[^"]*(")/;

export function syncVersion({ packageJson, tauriConf, cargoToml }) {
  const version = JSON.parse(readFileSync(packageJson, 'utf8')).version;
  if (!version) throw new Error('package.json has no version');

  const conf = JSON.parse(readFileSync(tauriConf, 'utf8'));
  conf.version = version;
  writeFileSync(tauriConf, JSON.stringify(conf, null, 2) + '\n');

  const cargo = readFileSync(cargoToml, 'utf8');
  if (!CARGO_PACKAGE_VERSION.test(cargo))
    throw new Error('Could not find [package] or [workspace.package] version in Cargo.toml');
  const patched = cargo.replace(CARGO_PACKAGE_VERSION, `$1${version}$2`);
  writeFileSync(cargoToml, patched);
  return version;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  const root = join(dirname(thisFile), '..');
  const v = syncVersion({
    packageJson: join(root, 'package.json'),
    tauriConf: join(root, 'src-tauri', 'tauri.conf.json'),
    cargoToml: join(root, 'Cargo.toml'),
  });
  console.log(`Synced version → ${v}`);
}
