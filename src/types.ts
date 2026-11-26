// IPC contract types — mirror CONTRACT.md exactly.

export type NodeId = number;

export type Category =
  | "video" | "image" | "audio" | "document"
  | "code" | "app" | "archive" | "other";

export interface Node {
  id: NodeId;
  parentId: NodeId | null;
  name: string;             // file name only; pseudo-nodes: synthetic label e.g. "312 small files"
  isDir: boolean;
  isBundle: boolean;
  isSymlink: boolean;
  isAggregate: boolean;     // true for bucketing pseudo-nodes; not a real filesystem object
  size: number;             // bytes; for dirs = exact sum of descendants (aggregate-inclusive)
  fileCount: number;        // real descendant file count inclusive
  category: Category;
  inaccessible: boolean;
  children: NodeId[] | null;
  mtime: number;            // unix seconds; 0 for aggregates
  hasHiddenChildren: boolean; // dirs whose small files were aggregated away — expand_dir candidates
}

export interface ScanStats {
  totalBytes: number;
  totalFiles: number;
  totalDirs: number;
  inaccessibleUnknownCount: number;
  durationMs: number;
}

export interface ScanProgressEvent {
  scanId: number;
  phase: "walking";
  currentPath: string;
  scannedFiles: number;
  scannedBytes: number;
}

export interface ScanNodesEvent {
  scanId: number;
  nodes: Node[];
  final: boolean;
}

export interface DirDetailEvent {
  parentId: NodeId;
  nodes: Node[];
  removedIds: NodeId[];
}

export interface ScanCompleteEvent {
  scanId: number;
  rootId: NodeId;
  rootName: string;
  stats: ScanStats;
}

export interface ScanCancelledEvent {
  scanId: number;
}

export interface ScanErrorEvent {
  scanId: number;
  message: string;
}

export interface FsEventsEvent {
  affectedRoots: string[];
}

export interface TreeUpdateEvent {
  rootId: NodeId;
  nodes: Node[];
  removedIds: NodeId[];
  rootSizeDelta: number;
}
