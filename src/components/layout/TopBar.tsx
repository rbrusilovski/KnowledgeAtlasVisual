"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Command, LogOut, Plus, Settings, Shield, User, Layers } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { Badge, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tooltip, Dialog, DialogContent } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActiveWorkspace, useMe, useQuota } from "@/lib/hooks";
import { useLive } from "@/lib/events";
import { useUi } from "@/lib/atlas/store";
import { signOut } from "@/lib/auth-client";
import { api } from "@/lib/api";
import { fmtInt } from "@/lib/format";
import { cn } from "@/lib/cn";

function QuotaMeter() {
  const { data } = useQuota();
  if (!data) return <div className="h-6 w-36 animate-pulse rounded-control bg-bg-3" />;
  const general = data.buckets.find((b) => b.bucket === "general")!;
  const search = data.buckets.find((b) => b.bucket === "search")!;
  const pct = Math.min(100, (general.used / general.limit) * 100);
  const reset = new Date(data.resetAt);
  return (
    <Tooltip
      content={
        <div className="space-y-1 py-0.5">
          <div>
            YouTube API: <span className="num">{fmtInt(general.used)}</span> / <span className="num">{fmtInt(general.limit)}</span> units today
          </div>
          <div>
            Searches: <span className="num">{search.used}</span> / <span className="num">{search.limit}</span>
            {data.user ? (
              <>
                {" "}
                · yours <span className="num">{data.user.used}</span>/<span className="num">{data.user.cap}</span>
              </>
            ) : null}
          </div>
          <div className="text-text-3">Resets {reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (midnight Pacific)</div>
          {general.exhausted || search.exhausted ? <div className="text-danger">A quota bucket is exhausted.</div> : null}
        </div>
      }
    >
      <div className="flex h-7 items-center gap-2 rounded-control border border-border bg-bg-2 px-2 text-xs text-text-2" aria-label="YouTube quota usage">
        <div className="h-1.5 w-14 overflow-hidden rounded-full bg-bg-3">
          <div className={cn("h-full rounded-full", pct > 85 ? "bg-danger" : pct > 60 ? "bg-warning" : "bg-accent-500")} style={{ width: `${pct}%` }} />
        </div>
        <span className="num">{fmtInt(general.remaining)}</span>
        <span className="text-text-3">·</span>
        <span className="num">{search.remaining}</span>
        <span className="text-text-3">searches</span>
      </div>
    </Tooltip>
  );
}

function LiveIndicator() {
  const { connected } = useLive();
  return (
    <Tooltip content={connected ? "Live updates connected" : "Live updates disconnected — reconnecting…"}>
      <div className="flex items-center gap-1.5 text-xs text-text-3" aria-live="polite">
        <span className={cn("size-1.5 rounded-full", connected ? "bg-success shadow-[0_0_6px] shadow-success/60" : "bg-text-3")} />
        {connected ? "Live" : "Offline"}
      </div>
    </Tooltip>
  );
}

function WorkspaceSwitcher() {
  const { workspace, workspaces, signedIn } = useActiveWorkspace();
  const setWorkspace = useUi((s) => s.setWorkspace);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  if (!signedIn) return null;
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button className="flex h-7 max-w-52 items-center gap-1.5 rounded-control px-2 text-sm text-text-2 hover:bg-bg-3 hover:text-text-1" aria-label="Switch workspace">
            <Layers className="size-4 stroke-[1.5]" />
            <span className="truncate">{workspace?.name ?? "Workspace"}</span>
            <ChevronDown className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuLabel>Workspaces</MenuLabel>
          {workspaces.map((w) => (
            <MenuItem key={w.id} onSelect={() => setWorkspace(w.id)} className={w.id === workspace?.id ? "text-text-1" : ""}>
              <span className={cn("size-1.5 rounded-full", w.id === workspace?.id ? "bg-accent-500" : "bg-transparent")} />
              {w.name}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => setOpen(true)}>
            <Plus /> New workspace
          </MenuItem>
        </MenuContent>
      </Menu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="New workspace" description="Workspaces keep separate collections, saved views and pinned layouts.">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const w = await api.post<{ id: string }>("/api/workspaces", { name });
                await qc.invalidateQueries({ queryKey: ["workspaces"] });
                setWorkspace(w.id);
                setOpen(false);
                setName("");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not create workspace");
              }
            }}
            className="space-y-3"
          >
            <Input autoFocus placeholder="Workspace name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={!name.trim()}>
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UserMenu() {
  const { data: me, isPending: isLoading } = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  if (isLoading) return <div className="size-7 animate-pulse rounded-full bg-bg-3" />;
  if (!me)
    return (
      <Button asChild size="sm" variant="primary">
        <Link href="/signin">Sign in</Link>
      </Button>
    );
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="flex size-7 items-center justify-center rounded-full border border-border bg-bg-3 text-xs font-semibold text-text-1 hover:border-border-strong" aria-label="Account menu">
          {me.name.slice(0, 1).toUpperCase()}
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>
          <div className="text-text-1">{me.name}</div>
          <div>{me.email}</div>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => router.push("/collections")}>
          <User /> Collections
        </MenuItem>
        <MenuItem onSelect={() => router.push("/settings")}>
          <Settings /> Settings
        </MenuItem>
        {me.role === "ADMIN" ? (
          <MenuItem onSelect={() => router.push("/admin")}>
            <Shield /> Admin
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem
          onSelect={async () => {
            await signOut();
            qc.clear();
            router.push("/");
          }}
        >
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function TopBar() {
  const { data: quota } = useQuota();
  const setPalette = useUi((s) => s.set);
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-bg-1 px-3">
      <Link href="/atlas" className="flex items-center gap-2 pr-1 text-[15px] font-semibold tracking-[-0.01em] text-text-1">
        <span className="relative flex size-5 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-accent-500/25 blur-[6px]" />
          <span className="size-2.5 rounded-full bg-accent-500 ring-2 ring-accent-500/30" />
        </span>
        Atlas
      </Link>
      <WorkspaceSwitcher />
      <nav className="ml-1 hidden items-center gap-0.5 md:flex" aria-label="Primary">
        {[
          ["/atlas", "Atlas"],
          ["/discover", "Discover"],
          ["/search", "Search"],
          ["/collections", "Collections"],
          ["/data", "Data"],
        ].map(([href, label]) => (
          <Link key={href} href={href!} className="rounded-control px-2 py-1 text-sm text-text-2 hover:bg-bg-3 hover:text-text-1">
            {label}
          </Link>
        ))}
      </nav>
      <button
        onClick={() => setPalette("paletteOpen", true)}
        className="ml-auto flex h-7 w-72 max-w-[30vw] items-center gap-2 rounded-control border border-border bg-bg-2 px-2 text-sm text-text-3 hover:border-border-strong hover:text-text-2"
        aria-label="Open command palette"
        data-testid="palette-trigger"
      >
        <Command className="size-3.5" />
        <span className="truncate">Search channels, videos, topics…</span>
        <span className="ml-auto flex gap-0.5">
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <QuotaMeter />
      {quota?.mode === "fixture" ? (
        <Tooltip content="Fixture mode: a clearly fictional demo dataset served through the real pipeline. Set YOUTUBE_MODE=live for real channels.">
          <span>
            <Badge tone="warning">Demo data</Badge>
          </span>
        </Tooltip>
      ) : null}
      <LiveIndicator />
      <UserMenu />
    </header>
  );
}
