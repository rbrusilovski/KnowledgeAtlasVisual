"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Command } from "cmdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FolderPlus, Hash, Layers, Link2, PanelLeft, PanelRight, Save, Search, Sparkles, Tv, Video, Waypoints } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { api } from "@/lib/api";
import { useUi } from "@/lib/atlas/store";
import { atlasGraph } from "@/lib/atlas/graph";
import { useActiveWorkspace } from "@/lib/hooks";
import { AddChannelDialog } from "./AddChannelDialog";
import type { SuggestItem } from "@/shared/contracts/search";

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

const ICON = { channel: Tv, video: Video, topic: Hash, niche: Layers } as const;

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const set = useUi((s) => s.set);
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim(), 120);
  const router = useRouter();
  const pathname = usePathname();
  const [addOpen, setAddOpen] = useState(false);
  const { workspace } = useActiveWorkspace();
  const qc = useQueryClient();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set("paletteOpen", !useUi.getState().paletteOpen);
      }
    };
    const onPrefill = (e: Event) => {
      setQ((e as CustomEvent<string>).detail);
      set("paletteOpen", true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("atlas:palette", onPrefill);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("atlas:palette", onPrefill);
    };
  }, [set]);

  const suggest = useQuery({ queryKey: ["suggest", dq], queryFn: () => api.get<SuggestItem[]>("/api/search/suggest", { q: dq, limit: 6 }), enabled: open && dq.length > 0, staleTime: 30_000 });

  const inAtlas = useMemo(() => {
    if (!open || !dq) return [];
    const needle = dq.toLowerCase();
    const out: { id: string; label: string; kind: string }[] = [];
    atlasGraph.forEachNode((id, a) => {
      if (out.length < 6 && a.label.toLowerCase().includes(needle)) out.push({ id, label: a.label, kind: a.kind });
    });
    return out;
  }, [open, dq]);

  const close = () => {
    set("paletteOpen", false);
    setQ("");
  };
  const focusNode = (nodeId: string) => {
    close();
    if (pathname === "/atlas") window.dispatchEvent(new CustomEvent("atlas:focus", { detail: nodeId }));
    else router.push(`/atlas?mode=local&focus=${encodeURIComponent(nodeId)}&depth=2`);
  };
  const groups = (["channel", "video", "topic", "niche"] as const).map((t) => [t, (suggest.data ?? []).filter((s) => s.type === t)] as const);

  return (
    <>
      <D.Root open={open} onOpenChange={(o) => (o ? set("paletteOpen", true) : close())}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
          <D.Content className="overlay fixed left-1/2 top-[14%] z-50 w-[min(94vw,640px)] -translate-x-1/2 overflow-hidden rounded-panel p-0" aria-label="Command palette">
            <D.Title className="sr-only">Command palette</D.Title>
            <D.Description className="sr-only">Search the atlas and run actions</D.Description>
            <Command shouldFilter={false} loop className="flex flex-col" label="Command palette">
              <div className="flex items-center gap-2 border-b border-border px-3">
                <Search className="size-4 text-text-3" />
                <Command.Input value={q} onValueChange={setQ} placeholder="Search channels, videos, topics, niches… or type a command" className="h-12 flex-1 bg-transparent text-base text-text-1 outline-none placeholder:text-text-3" data-testid="palette-input" />
              </div>
              <Command.List className="max-h-[56vh] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-text-3">
                {dq && suggest.isFetching && !suggest.data ? <Command.Loading><div className="px-3 py-2 text-sm text-text-3">Searching…</div></Command.Loading> : null}
                {dq && !suggest.isFetching && !inAtlas.length && !(suggest.data ?? []).length ? <Command.Empty className="px-3 py-3 text-sm text-text-3">No matches in the atlas.</Command.Empty> : null}
                {inAtlas.length ? (
                  <Command.Group heading="Atlas nodes">
                    {inAtlas.map((n) => (
                      <Item key={`a-${n.id}`} value={`atlas ${n.id}`} onSelect={() => focusNode(n.id)} icon={<Waypoints />} label={n.label} hint={n.kind.toLowerCase()} />
                    ))}
                  </Command.Group>
                ) : null}
                {groups.map(([t, items]) =>
                  items.length ? (
                    <Command.Group key={t} heading={t === "niche" ? "Niches" : `${t[0]!.toUpperCase()}${t.slice(1)}s`}>
                      {items.map((s) => {
                        const Icon = ICON[s.type];
                        return (
                          <Item
                            key={s.nodeId}
                            value={s.nodeId}
                            onSelect={() => {
                              if (s.type === "video") {
                                close();
                                router.push(`/videos/${s.nodeId.slice(6)}`);
                              } else focusNode(s.nodeId);
                            }}
                            icon={s.thumbnailUrl ? <img src={s.thumbnailUrl} alt="" className="size-4 rounded-full" /> : <Icon />}
                            label={s.label}
                            hint={s.sublabel ?? undefined}
                          />
                        );
                      })}
                    </Command.Group>
                  ) : null,
                )}
                <Command.Group heading="Actions">
                  {dq ? <Item value="act-search" onSelect={() => (close(), router.push(`/search?q=${encodeURIComponent(dq)}`))} icon={<Search />} label={`Search everything for “${dq}”`} /> : null}
                  <Item value="act-discover" onSelect={() => (close(), router.push(dq ? `/discover?q=${encodeURIComponent(dq)}` : "/discover"))} icon={<Sparkles />} label={dq ? `Discover channels for “${dq}” on YouTube` : "Discover channels on YouTube"} />
                  <Item value="act-add" onSelect={() => (close(), setAddOpen(true))} icon={<Link2 />} label="Add channel by URL" />
                  {workspace ? (
                    <Item
                      value="act-collection"
                      onSelect={async () => {
                        const name = dq || "New collection";
                        close();
                        try {
                          await api.post(`/api/workspaces/${workspace.id}/collections`, { name });
                          await qc.invalidateQueries({ queryKey: ["collections", workspace.id] });
                          toast.success(`Created collection “${name}”`);
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Could not create");
                        }
                      }}
                      icon={<FolderPlus />}
                      label={dq ? `New collection “${dq}”` : "New collection"}
                    />
                  ) : null}
                  {pathname === "/atlas" ? <Item value="act-save" onSelect={() => (close(), window.dispatchEvent(new CustomEvent("atlas:save-view")))} icon={<Save />} label="Save current view" /> : null}
                  <Item value="act-sidebar" onSelect={() => (close(), useUi.getState().toggleSidebar())} icon={<PanelLeft />} label="Toggle sidebar" hint="[" />
                  <Item value="act-inspector" onSelect={() => (close(), useUi.getState().toggleInspector())} icon={<PanelRight />} label="Toggle inspector" hint="]" />
                  {useUi.getState().selected[0] ? (
                    <Item value="act-local" onSelect={() => (close(), router.push(`/atlas?mode=local&focus=${encodeURIComponent(useUi.getState().selected[0]!)}&depth=2`))} icon={<Waypoints />} label="Switch to local graph" />
                  ) : null}
                </Command.Group>
              </Command.List>
            </Command>
          </D.Content>
        </D.Portal>
      </D.Root>
      <AddChannelDialog open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}

function Item({ value, onSelect, icon, label, hint }: { value: string; onSelect: () => void; icon: React.ReactNode; label: string; hint?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="flex h-9 cursor-default items-center gap-2.5 rounded-[7px] px-2 text-sm text-text-2 aria-selected:bg-bg-3 aria-selected:text-text-1 [&_svg]:size-4 [&_svg]:stroke-[1.5] [&_svg]:text-text-3">
      <span className="flex size-4 items-center justify-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint ? <span className="truncate text-xs text-text-3">{hint}</span> : null}
    </Command.Item>
  );
}
