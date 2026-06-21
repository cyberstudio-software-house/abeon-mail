import type { Folder } from "../../ipc/bindings";

export type FolderNode = {
  segment: string;
  fullPath: string;
  folder: Folder | null;
  children: FolderNode[];
};

function decodeModifiedBase64(b64: string): string {
  const std = b64.replace(/,/g, "/");
  const pad = std.length % 4 === 0 ? "" : "=".repeat(4 - (std.length % 4));
  let binary: string;
  try {
    binary = atob(std + pad);
  } catch {
    return b64;
  }
  let out = "";
  for (let i = 0; i + 1 < binary.length; i += 2) {
    out += String.fromCharCode((binary.charCodeAt(i) << 8) | binary.charCodeAt(i + 1));
  }
  return out;
}

export function decodeImapUtf7(input: string): string {
  if (!input.includes("&")) return input;
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "&") {
      const end = input.indexOf("-", i + 1);
      if (end === -1) {
        result += input.slice(i);
        break;
      }
      const chunk = input.slice(i + 1, end);
      result += chunk === "" ? "&" : decodeModifiedBase64(chunk);
      i = end + 1;
    } else {
      result += input[i];
      i += 1;
    }
  }
  return result;
}

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
    const node: FolderNode = { segment: decodeImapUtf7(segment), fullPath, folder: null, children: [] };
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

export const PRIORITY_FOLDER_TYPES = ["inbox", "sent", "trash", "drafts"] as const;

export function partitionPriorityFolders(folders: Folder[]): {
  priority: Folder[];
  rest: Folder[];
} {
  const priorityTypes = PRIORITY_FOLDER_TYPES as readonly string[];
  const priority: Folder[] = [];
  const rest: Folder[] = [];
  for (const folder of folders) {
    if (priorityTypes.includes(folder.folder_type)) priority.push(folder);
    else rest.push(folder);
  }
  priority.sort(
    (a, b) => priorityTypes.indexOf(a.folder_type) - priorityTypes.indexOf(b.folder_type),
  );
  return { priority, rest };
}

export function sortFolderNodes(nodes: FolderNode[]): FolderNode[] {
  const sorted = [...nodes].sort((a, b) =>
    a.segment.localeCompare(b.segment, "pl", { sensitivity: "base" }),
  );
  for (const node of sorted) {
    node.children = sortFolderNodes(node.children);
  }
  return sorted;
}

export type FlatFolderNode = { node: FolderNode; depth: number };

export function flattenFolderTree(nodes: FolderNode[], depth = 0): FlatFolderNode[] {
  const out: FlatFolderNode[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    out.push(...flattenFolderTree(node.children, depth + 1));
  }
  return out;
}
