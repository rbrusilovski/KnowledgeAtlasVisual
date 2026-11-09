"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { useUi } from "@/lib/atlas/store";

export interface Me {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: "USER" | "ADMIN";
  reducedMotion: boolean;
  defaultLayout: string;
  youtubeConnection: { channelIds: string[]; createdAt: string } | null;
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<Me>("/api/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export interface WorkspaceDTO {
  id: string;
  name: string;
  description: string | null;
  _count: { collections: number; savedViews: number; layouts: number };
}
export interface CollectionDTO {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  sortOrder: number;
  _count: { items: number };
}
export interface SavedViewDTO {
  id: string;
  workspaceId: string;
  name: string;
  state: Record<string, unknown>;
  createdAt: string;
}

export function useWorkspaces(enabled = true) {
  return useQuery({ queryKey: ["workspaces"], queryFn: () => api.get<WorkspaceDTO[]>("/api/workspaces"), enabled });
}

/** The active workspace (remembered per browser), falling back to the first one. */
export function useActiveWorkspace() {
  const me = useMe();
  const ws = useWorkspaces(Boolean(me.data));
  const activeId = useUi((s) => s.workspaceId);
  const active = ws.data?.find((w) => w.id === activeId) ?? ws.data?.[0] ?? null;
  // isPending (not isLoading): on the server and the first client render the query is pending but not fetching,
  // so both render the same skeleton (no hydration mismatch).
  return { workspace: active, workspaces: ws.data ?? [], isLoading: me.isPending || (Boolean(me.data) && ws.isPending), signedIn: Boolean(me.data) };
}

export function useCollections(workspaceId: string | undefined) {
  return useQuery({ queryKey: ["collections", workspaceId], queryFn: () => api.get<CollectionDTO[]>(`/api/workspaces/${workspaceId}/collections`), enabled: Boolean(workspaceId) });
}

export function useViews(workspaceId: string | undefined) {
  return useQuery({ queryKey: ["views", workspaceId], queryFn: () => api.get<SavedViewDTO[]>(`/api/workspaces/${workspaceId}/views`), enabled: Boolean(workspaceId) });
}

export function useMembership(workspaceId: string | undefined) {
  return useQuery({ queryKey: ["membership", workspaceId], queryFn: () => api.get<Record<string, string[]>>(`/api/workspaces/${workspaceId}/membership`), enabled: Boolean(workspaceId) });
}

export interface QuotaDTO {
  day: string;
  resetAt: string;
  mode: "live" | "fixture";
  model: string;
  buckets: { bucket: "general" | "search"; used: number; limit: number; remaining: number; backgroundCap: number; exhausted: boolean }[];
  user: { used: number; cap: number } | null;
  data?: { demoChannels: number; liveChannels: number; liveCollection: boolean };
}
export function useQuota() {
  return useQuery({ queryKey: ["quota"], queryFn: () => api.get<QuotaDTO>("/api/quota"), refetchInterval: 60_000 });
}

export interface NicheNode {
  id: string;
  slug: string;
  name: string;
  description: string;
  nodeId: string;
  channelCount: number;
  discoveryQueries: string[];
  children: NicheNode[];
}
export function useNiches() {
  return useQuery({ queryKey: ["niches"], queryFn: () => api.get<NicheNode[]>("/api/niches"), staleTime: 5 * 60_000 });
}

/** Add nodes to a collection with an optimistic count bump. */
export function useAddToCollection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ collectionId, nodeIds }: { collectionId: string; workspaceId?: string; nodeIds: string[] }) =>
      api.post<{ added: number; skipped: number }>(`/api/collections/${collectionId}/items`, { items: nodeIds.map((nodeId) => ({ nodeId })) }),
    onMutate: async ({ collectionId, workspaceId, nodeIds }) => {
      const key = ["collections", workspaceId];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<CollectionDTO[]>(key);
      qc.setQueryData<CollectionDTO[]>(key, (old) => old?.map((c) => (c.id === collectionId ? { ...c, _count: { items: c._count.items + nodeIds.length } } : c)));
      return { prev, key };
    },
    onError: (_e, _v, ctx) => ctx && qc.setQueryData(ctx.key, ctx.prev),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ["collections", v.workspaceId] });
      void qc.invalidateQueries({ queryKey: ["collection", v.collectionId] });
      void qc.invalidateQueries({ queryKey: ["membership", v.workspaceId] });
    },
  });
}
