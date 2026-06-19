import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

function tauriVersion(): string {
  const conf = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
  return conf.version;
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return pkg.version;
}

function workspaceCargoVersion(): string {
  const toml = readFileSync(resolve(root, "Cargo.toml"), "utf8");
  const block = toml.slice(toml.indexOf("[workspace.package]"));
  const match = block.match(/version\s*=\s*"([^"]+)"/);
  if (!match) throw new Error("workspace version not found");
  return match[1];
}

describe("version consistency", () => {
  it("tauri.conf.json, package.json and workspace Cargo.toml share one version", () => {
    const tauri = tauriVersion();
    const pkg = packageVersion();
    const cargo = workspaceCargoVersion();
    expect(pkg).toBe(tauri);
    expect(cargo).toBe(tauri);
  });
});
