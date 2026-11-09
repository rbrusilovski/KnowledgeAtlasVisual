"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Download, Link2, Trash2 } from "lucide-react";
import { Page } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, EmptyState, Skeleton, Switch } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid grid-cols-1 gap-4 border-b border-border py-6 md:grid-cols-[240px_1fr]">
      <div>
        <h2 className="text-base text-text-1">{title}</h2>
        {description ? <p className="mt-1 text-sm text-text-3">{description}</p> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function NameForm({ current, onSave }: { current: string; onSave: (name: string) => void }) {
  const [name, setName] = useState(current);
  return (
    <form onSubmit={(e) => (e.preventDefault(), onSave(name.trim()))} className="flex max-w-md gap-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" maxLength={80} />
      <Button type="submit" variant="secondary" disabled={!name.trim() || name === current}>Save</Button>
    </form>
  );
}

export function SettingsPage({ youtubeOAuth }: { youtubeOAuth: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const [del, setDel] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  useEffect(() => {
    const y = sp.get("youtube");
    if (y?.startsWith("connected")) toast.success(`YouTube connected (${y.split(":")[1] ?? 0} channels)`);
    if (y === "denied") toast.error("YouTube connection was cancelled");
  }, [sp]);

  if (me.isPending) return <Page><Skeleton className="h-64" /></Page>;
  if (!me.data)
    return (
      <Page>
        <EmptyState title="Sign in to manage settings"><Button asChild variant="primary"><Link href="/signin?next=/settings">Sign in</Link></Button></EmptyState>
      </Page>
    );
  const u = me.data;
  const patch = async (body: Record<string, unknown>, msg = "Saved") => {
    try {
      await api.patch("/api/me/settings", body);
      await qc.invalidateQueries({ queryKey: ["me"] });
      toast.success(msg);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    }
  };
  return (
    <Page>
      <h1 className="text-xl text-text-1">Settings</h1>
      <Section title="Profile" description="How you appear in Atlas.">
        <NameForm key={u.name} current={u.name} onSave={(name) => void patch({ name })} />
        <p className="text-sm text-text-3">{u.email} · joined {fmtDate((u as unknown as { createdAt?: string }).createdAt ?? null)} · {u.role.toLowerCase()}</p>
      </Section>
      <Section title="Preferences">
        <label className="flex max-w-md items-center justify-between text-sm text-text-2">
          Reduce motion
          <Switch checked={u.reducedMotion} onCheckedChange={(v) => void patch({ reducedMotion: v })} aria-label="Reduce motion" />
        </label>
        <label className="flex max-w-md items-center justify-between text-sm text-text-2">
          Default atlas layout
          <select value={u.defaultLayout} onChange={(e) => void patch({ defaultLayout: e.target.value })} className="h-8 rounded-control border border-border bg-bg-3/60 px-2 text-sm" aria-label="Default atlas layout">
            <option value="global">Global graph</option>
            <option value="local">Local graph (last selection)</option>
          </select>
        </label>
      </Section>
      <Section title="YouTube account" description="Connect a channel you own to import its captions as transcripts (uses the youtube.force-ssl scope).">
        {!youtubeOAuth ? (
          <p className="text-sm text-text-3">Not enabled on this server (FEATURE_YOUTUBE_OAUTH).</p>
        ) : u.youtubeConnection ? (
          <div className="flex items-center gap-3 text-sm text-text-2">
            Connected · {u.youtubeConnection.channelIds.length} channel(s)
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await api.del("/api/youtube/connection");
                await qc.invalidateQueries({ queryKey: ["me"] });
                toast.success("Disconnected; captions obtained through it were deleted");
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <Button asChild variant="secondary"><a href="/api/youtube/connect"><Link2 /> Connect YouTube</a></Button>
        )}
      </Section>
      <Section title="Your data" description="Export everything Atlas stores about you, or delete your account.">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary"><a href="/api/me/export"><Download /> Export my data</a></Button>
          <Button variant="danger" onClick={() => setDel(true)}><Trash2 /> Delete account</Button>
        </div>
      </Section>
      <Dialog open={del} onOpenChange={setDel}>
        <DialogContent title="Delete your account?" description="This permanently deletes your workspaces, collections, notes, saved views, layouts, uploaded transcripts and discovery history. It cannot be undone.">
          <p className="mb-2 text-sm text-text-2">Type <span className="num text-text-1">delete</span> to confirm.</p>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} aria-label="Confirmation" />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDel(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={confirmText !== "delete"}
              onClick={async () => {
                await api.del("/api/me");
                qc.clear();
                router.push("/");
                router.refresh();
              }}
            >
              Delete permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
