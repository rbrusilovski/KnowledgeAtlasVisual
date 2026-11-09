"use client";

import { reviewProposal } from "@/components/expansion/ProposalReview";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/misc";
import { api, ApiError } from "@/lib/api";
import type { AddChannelResult } from "@/shared/contracts/jobs";

export function AddChannelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ units: number; bucket: string; reason: string } | null>(null);

  const submit = async (withConfirm = false) => {
    setBusy(true);
    try {
      const r = await api.post<AddChannelResult>("/api/channels", { input, confirm: withConfirm || undefined });
      if (r.status === "exists") {
        toast.info(`${r.channel?.title} is already in the atlas`, { action: r.channel ? { label: "Show", onClick: () => window.dispatchEvent(new CustomEvent("atlas:focus", { detail: r.channel!.nodeId })) } : undefined });
      } else if (r.proposal) {
        reviewProposal(r.proposal); // nothing is collected until the user approves this exact scope
      }
      setInput("");
      setConfirm(null);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "NEEDS_CONFIRMATION") {
        const d = e.details as { needsConfirmation?: { cost: { units: number; bucket: string } } };
        setConfirm({ units: d.needsConfirmation?.cost.units ?? 1, bucket: d.needsConfirmation?.cost.bucket ?? "search", reason: e.message });
      } else toast.error(e instanceof Error ? e.message : "Could not add channel");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (onOpenChange(o), !o && setConfirm(null))}>
      <DialogContent title="Add channel" description="Paste a channel URL, @handle, channel ID or any video URL. Cheap lookups are tried first.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
          className="space-y-3"
        >
          <Input autoFocus value={input} onChange={(e) => (setInput(e.target.value), setConfirm(null))} placeholder="https://youtube.com/@handle" aria-label="Channel URL or handle" data-testid="add-channel-input" />
          {confirm ? (
            <div className="rounded-card border border-warning/30 bg-warning/10 p-3 text-sm text-text-2">
              {confirm.reason}
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-text-3">
                  Uses {confirm.units} of today’s {confirm.bucket === "search" ? "searches" : "API units"}.
                </span>
                <Button size="sm" variant="primary" type="button" onClick={() => void submit(true)} disabled={busy}>
                  Use 1 search
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!input.trim() || busy}>
              {busy ? "Resolving…" : "Review & add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
