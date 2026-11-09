"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ColorBy = "type" | "niche" | "community";
export type LabelMode = "auto" | "all" | "none";
export type SizeBy = "subscribers" | "views" | "degree";

export interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
}
export interface HoverState {
  nodeId: string;
  x: number;
  y: number;
}

interface UiState {
  workspaceId: string | null;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  colorBy: ColorBy;
  labels: LabelMode;
  sizeBy: SizeBy;
  listView: boolean;
  layoutRunning: boolean;
  selected: string[];
  hovered: HoverState | null;
  contextMenu: ContextMenuState | null;
  paletteOpen: boolean;
  hidden: string[];
  graphStats: { nodes: number; edges: number; visible: number; version: string | null; truncated: boolean };
  setWorkspace(id: string): void;
  toggleSidebar(v?: boolean): void;
  toggleInspector(v?: boolean): void;
  set<K extends keyof UiState>(k: K, v: UiState[K]): void;
  select(ids: string[], mode?: "replace" | "toggle" | "add"): void;
  hide(ids: string[]): void;
  unhideAll(): void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      workspaceId: null,
      sidebarOpen: true,
      inspectorOpen: true,
      colorBy: "niche",
      labels: "auto",
      sizeBy: "subscribers",
      listView: false,
      layoutRunning: false,
      selected: [],
      hovered: null,
      contextMenu: null,
      paletteOpen: false,
      hidden: [],
      graphStats: { nodes: 0, edges: 0, visible: 0, version: null, truncated: false },
      setWorkspace: (id) => set({ workspaceId: id }),
      toggleSidebar: (v) => set((s) => ({ sidebarOpen: v ?? !s.sidebarOpen })),
      toggleInspector: (v) => set((s) => ({ inspectorOpen: v ?? !s.inspectorOpen })),
      set: (k, v) => set({ [k]: v } as Partial<UiState>),
      select: (ids, mode = "replace") =>
        set((s) => {
          if (mode === "replace") return { selected: ids, inspectorOpen: ids.length ? true : s.inspectorOpen };
          const cur = new Set(s.selected);
          for (const id of ids) {
            if (mode === "toggle" && cur.has(id)) cur.delete(id);
            else cur.add(id);
          }
          return { selected: [...cur] };
        }),
      hide: (ids) => set((s) => ({ hidden: [...new Set([...s.hidden, ...ids])], selected: s.selected.filter((x) => !ids.includes(x)) })),
      unhideAll: () => set({ hidden: [] }),
    }),
    {
      name: "atlas-ui",
      partialize: (s) => ({ workspaceId: s.workspaceId, sidebarOpen: s.sidebarOpen, inspectorOpen: s.inspectorOpen, colorBy: s.colorBy, labels: s.labels, sizeBy: s.sizeBy }),
    },
  ),
);
