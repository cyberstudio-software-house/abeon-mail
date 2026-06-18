import { describe, it, expect } from "vitest";
import { recoverDelimiter, buildFolderTree } from "./folder-tree";
import type { Folder } from "../../ipc/bindings";

function f(id: number, remote_path: string, name: string): Folder {
  return {
    id,
    account_id: 1,
    remote_path,
    name,
    folder_type: "custom",
    unread_count: 0,
    total_count: 0,
  } as Folder;
}

describe("recoverDelimiter", () => {
  it("returns the char before the leaf name", () => {
    expect(recoverDelimiter("Archives.2023", "2023")).toBe(".");
    expect(recoverDelimiter("Work/Clients", "Clients")).toBe("/");
  });
  it("returns null for a root folder (path equals name)", () => {
    expect(recoverDelimiter("Junk", "Junk")).toBeNull();
  });
});

describe("buildFolderTree", () => {
  it("keeps flat folders as roots", () => {
    const tree = buildFolderTree([f(1, "Junk", "Junk"), f(2, "Archive", "Archive")]);
    expect(tree.map((n) => n.segment)).toEqual(["Junk", "Archive"]);
    expect(tree[0].folder?.id).toBe(1);
    expect(tree[0].children).toEqual([]);
  });

  it("nests children under a real parent", () => {
    const tree = buildFolderTree([
      f(1, "Archives", "Archives"),
      f(2, "Archives.2023", "2023"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].folder?.id).toBe(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].folder?.id).toBe(2);
    expect(tree[0].children[0].segment).toBe("2023");
  });

  it("creates a virtual container when the parent has no real folder", () => {
    const tree = buildFolderTree([
      f(2, "Klienci_Sm.eGniazdko", "eGniazdko"),
      f(3, "Klienci_Sm.mmRental", "mmRental"),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].segment).toBe("Klienci_Sm");
    expect(tree[0].folder).toBeNull();
    expect(tree[0].children.map((c) => c.segment).sort()).toEqual(["eGniazdko", "mmRental"]);
  });
});
