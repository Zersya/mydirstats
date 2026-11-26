// Thin IPC layer: real Tauri invoke/listen when present, dev mock otherwise.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type {
  Node,
  ScanProgressEvent,
  ScanNodesEvent,
  ScanCompleteEvent,
  ScanCancelledEvent,
  ScanErrorEvent,
  FsEventsEvent,
  TreeUpdateEvent,
  DirDetailEvent,
} from "./types";
import { MockBackend } from "./mock";

type Unlisten = () => void;
type Handler<T> = (payload: T) => void;

export interface Backend {
  invoke(cmd: "start_scan", args: { path: string }): Promise<{ scanId: number }>;
  invoke(cmd: "scan_progress_poll"): Promise<{ scanId: number; phase: number; files: number; bytes: number; currentPath: string }>;
  invoke(cmd: "cancel_scan"): Promise<void>;
  invoke(cmd: "expand_dir", args: { id: number }): Promise<void>;
  invoke(cmd: "trash_items", args: { paths: string[] }): Promise<{ trashed: string[]; failed: { path: string; error: string }[] }>;
  invoke(cmd: "reveal_in_finder", args: { path: string }): Promise<void>;
  invoke(cmd: "copy_path", args: { path: string }): Promise<void>;
  invoke(cmd: "quick_look", args: { path: string }): Promise<void>;
  invoke(cmd: "open_full_disk_access_settings"): Promise<void>;
  invoke(cmd: "expand_bundle", args: { id: number }): Promise<void>;
  invoke(cmd: "default_scan_path"): Promise<{ path: string }>;
  listen(event: "scan-progress", handler: Handler<ScanProgressEvent>): Promise<Unlisten>;
  listen(event: "scan-nodes", handler: Handler<ScanNodesEvent>): Promise<Unlisten>;
  listen(event: "scan-complete", handler: Handler<ScanCompleteEvent>): Promise<Unlisten>;
  listen(event: "scan-cancelled", handler: Handler<ScanCancelledEvent>): Promise<Unlisten>;
  listen(event: "scan-error", handler: Handler<ScanErrorEvent>): Promise<Unlisten>;
  listen(event: "fs-events", handler: Handler<FsEventsEvent>): Promise<Unlisten>;
  listen(event: "tree-update", handler: Handler<TreeUpdateEvent>): Promise<Unlisten>;
  listen(event: "dir-detail", handler: Handler<DirDetailEvent>): Promise<Unlisten>;
}

const hasTauri = typeof window !== "undefined" && "__TAURI__" in window;

function createTauriBackend(): Backend {
  return {
    invoke: ((cmd: string, args?: unknown) => tauriInvoke(cmd, args as Record<string, unknown>)) as Backend["invoke"],
    listen: ((event: string, handler: (payload: unknown) => void) =>
      tauriListen(event, (e) => handler(e.payload))) as Backend["listen"],
  };
}

let instance: Backend | null = null;

export function getBackend(): Backend {
  if (!instance) {
    instance = hasTauri ? createTauriBackend() : new MockBackend();
  }
  return instance;
}

export type { Node };
