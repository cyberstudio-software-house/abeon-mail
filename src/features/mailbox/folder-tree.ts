import type { Folder } from "../../ipc/bindings";

export type FolderNode = {
  segment: string;
  fullPath: string;
  folder: Folder | null;
  children: FolderNode[];
};

export function recoverDelimiter(remotePath: string, name: string): string | null {
  if (remotePath.length <= name.length) return null;
  if (!remotePath.endsWith(name)) return null;
  return remotePath[remotePath.length - name.length - 1];
}

export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();

  function ensureNode(fullPath: string, segment: string, parent: FolderNode | null): FolderNode {
    const existing = byPath.get(fullPath);
    if (existing) return existing;
    const node: FolderNode = { segment, fullPath, folder: null, children: [] };
    byPath.set(fullPath, node);
    if (parent) parent.children.push(node);
    else roots.push(node);
    return node;
  }

  for (const folder of folders) {
    const delim = recoverDelimiter(folder.remote_path, folder.name);
    if (delim === null) {
      const node = ensureNode(folder.remote_path, folder.name, null);
      node.folder = folder;
      continue;
    }
    const segments = folder.remote_path.split(delim);
    let parent: FolderNode | null = null;
    let accPath = "";
    for (let i = 0; i < segments.length; i += 1) {
      accPath = i === 0 ? segments[0] : accPath + delim + segments[i];
      const node = ensureNode(accPath, segments[i], parent);
      parent = node;
    }
    if (parent) parent.folder = folder;
  }

  return roots;
}
