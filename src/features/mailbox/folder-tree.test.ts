import { describe, it, expect } from "vitest";
import {
  recoverDelimiter,
  buildFolderTree,
  partitionPriorityFolders,
  sortFolderNodes,
  decodeImapUtf7,
} from "./folder-tree";
import type { Folder, FolderType } from "../../ipc/bindings";

function f(
  id: number,
  remote_path: string,
  name: string,
  folder_type: FolderType = "custom",
): Folder {
  return {
    id,
    account_id: 1,
    remote_path,
    name,
    folder_type,
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

describe("decodeImapUtf7", () => {
  it("leaves plain ASCII untouched", () => {
    expect(decodeImapUtf7("INBOX")).toBe("INBOX");
    expect(decodeImapUtf7("Sent Mail")).toBe("Sent Mail");
  });

  it("decodes a modified-UTF-7 run (Polish diacritics)", () => {
    expect(decodeImapUtf7("B&AUIBGQ-dy")).toBe("Błędy");
    expect(decodeImapUtf7("Wys&AUI-ane")).toBe("Wysłane");
  });

  it("decodes a literal ampersand (&-)", () => {
    expect(decodeImapUtf7("R&-D")).toBe("R&D");
  });

  it("decodes a segment that is entirely encoded", () => {
    expect(decodeImapUtf7("&AUIBGQ-")).toBe("łę");
  });
});

describe("buildFolderTree (mUTF-7 decoding)", () => {
  it("decodes nested segment names for display while keeping fullPath raw", () => {
    const tree = buildFolderTree([
      f(1, "cyberstudio", "cyberstudio"),
      f(2, "cyberstudio.B&AUIBGQ-dy", "B&AUIBGQ-dy"),
    ]);
    const child = tree[0].children[0];
    expect(child.segment).toBe("Błędy");
    expect(child.fullPath).toBe("cyberstudio.B&AUIBGQ-dy");
  });
});

describe("partitionPriorityFolders", () => {
  it("pulls key folders out in fixed inbox/sent/trash/drafts order", () => {
    const { priority, rest } = partitionPriorityFolders([
      f(1, "Work", "Work"),
      f(2, "Drafts", "Drafts", "drafts"),
      f(3, "INBOX", "INBOX", "inbox"),
      f(4, "Trash", "Trash", "trash"),
      f(5, "Sent", "Sent", "sent"),
    ]);
    expect(priority.map((p) => p.folder_type)).toEqual(["inbox", "sent", "trash", "drafts"]);
    expect(rest.map((r) => r.name)).toEqual(["Work"]);
  });

  it("lifts nested key folders (Gmail-style) regardless of nesting", () => {
    const { priority, rest } = partitionPriorityFolders([
      f(1, "INBOX", "INBOX", "inbox"),
      f(2, "[Gmail].Sent Mail", "Sent Mail", "sent"),
      f(3, "[Gmail].All Mail", "All Mail"),
    ]);
    expect(priority.map((p) => p.name)).toEqual(["INBOX", "Sent Mail"]);
    expect(rest.map((r) => r.name)).toEqual(["All Mail"]);
  });
});

describe("sortFolderNodes", () => {
  it("sorts siblings alphabetically, case- and diacritic-insensitive, recursively", () => {
    const tree = sortFolderNodes(
      buildFolderTree([
        f(1, "zebra", "zebra"),
        f(2, "Łąka", "Łąka"),
        f(3, "apple", "apple"),
        f(4, "apple.Zulu", "Zulu"),
        f(5, "apple.alpha", "alpha"),
      ]),
    );
    expect(tree.map((n) => n.segment)).toEqual(["apple", "Łąka", "zebra"]);
    const apple = tree.find((n) => n.segment === "apple")!;
    expect(apple.children.map((c) => c.segment)).toEqual(["alpha", "Zulu"]);
  });
});
