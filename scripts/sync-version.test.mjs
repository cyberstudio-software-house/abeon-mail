import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncVersion } from './sync-version.mjs';

describe('syncVersion', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'syncver-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }, null, 2));
    writeFileSync(join(dir, 'tauri.conf.json'), JSON.stringify({ productName: 'X', version: '0.0.0' }, null, 2));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run() {
    return syncVersion({
      packageJson: join(dir, 'package.json'),
      tauriConf: join(dir, 'tauri.conf.json'),
      cargoToml: join(dir, 'Cargo.toml'),
    });
  }

  it('propagates package.json version into tauri.conf.json', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.0.0"\nedition = "2021"\n');
    run();
    expect(JSON.parse(readFileSync(join(dir, 'tauri.conf.json'), 'utf8')).version).toBe('1.2.3');
  });

  it('rewrites a plain [package] version', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.0.0"\nedition = "2021"\n');
    run();
    expect(readFileSync(join(dir, 'Cargo.toml'), 'utf8')).toContain('version = "1.2.3"');
  });

  it('rewrites a [workspace.package] version', () => {
    writeFileSync(join(dir, 'Cargo.toml'),
      '[workspace]\nmembers = ["a"]\n\n[workspace.package]\nedition = "2021"\nversion = "0.0.0"\n\n[workspace.dependencies]\nserde = { version = "1" }\n');
    run();
    const cargo = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
    expect(cargo).toContain('[workspace.package]\nedition = "2021"\nversion = "1.2.3"');
    expect(cargo).toContain('serde = { version = "1" }');
  });

  it('only rewrites the package version, not other version keys', () => {
    writeFileSync(join(dir, 'Cargo.toml'),
      '[package]\nname = "x"\nversion = "0.0.0"\n\n[dependencies]\nfoo = { version = "9.9.9" }\n');
    run();
    const cargo = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
    expect(cargo).toContain('version = "1.2.3"');
    expect(cargo).toContain('foo = { version = "9.9.9" }');
  });

  it('throws when no package version section exists', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[dependencies]\nfoo = { version = "9.9.9" }\n');
    expect(() => run()).toThrow();
  });
});
