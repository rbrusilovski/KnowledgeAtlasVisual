"use client";

import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/misc";
import { LiveProvider } from "@/lib/events";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <LiveProvider>
      <TooltipProvider delayDuration={300}>
        <div className="flex h-dvh flex-col overflow-hidden">
          <TopBar />
          <div className="flex min-h-0 flex-1">{children}</div>
        </div>
        <CommandPalette />
      </TooltipProvider>
    </LiveProvider>
  );
}

/** Scrollable page body for non-atlas pages. */
export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className={wide ? "mx-auto max-w-7xl px-6 py-8" : "mx-auto max-w-5xl px-6 py-8"}>{children}</div>
    </main>
  );
}
