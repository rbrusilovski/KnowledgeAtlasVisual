import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowRight, Network, Search, Sparkles } from "lucide-react";
import { getSessionUser } from "@/server/session";
import { features } from "@/server/env";

export const dynamic = "force-dynamic";

export default async function Landing() {
  if (await getSessionUser(await headers())) redirect("/atlas");
  return (
    <main className="canvas-bg relative flex min-h-dvh flex-col">
      <header className="flex h-14 items-center justify-between px-6">
        <span className="flex items-center gap-2 text-md font-semibold text-text-1">
          <span className="size-2.5 rounded-full bg-accent-500 ring-2 ring-accent-500/30" /> Atlas
        </span>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/privacy" className="text-text-3 hover:text-text-1">Privacy</Link>
          <Link href="/signin" className="rounded-control border border-border px-3 py-1.5 text-text-1 hover:border-border-strong">Sign in</Link>
        </nav>
      </header>
      <section className="mx-auto flex max-w-3xl flex-1 flex-col items-center justify-center px-6 pb-24 text-center">
        <span className="mb-5 rounded-full border border-accent-500/30 bg-accent-500/10 px-3 py-1 text-xs text-accent-300">A research workspace for YouTube</span>
        <h1 className="text-[44px] font-semibold leading-[1.08] tracking-[-0.02em] text-text-1 md:text-[56px]">The knowledge atlas of YouTube</h1>
        <p className="mt-5 max-w-xl text-md text-text-2">Map niches, subniches, channels, videos and topics as one explorable graph — then search transcripts, save findings and watch the map grow as new channels are ingested.</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link href="/atlas" className="inline-flex h-10 items-center gap-2 rounded-control bg-accent-500 px-5 text-base font-medium text-white shadow-[0_8px_30px_rgb(67_97_255/0.35)] hover:bg-accent-600">
            Open the atlas <ArrowRight className="size-4" />
          </Link>
          <Link href="/signin" className="inline-flex h-10 items-center rounded-control border border-border px-5 text-base text-text-1 hover:border-border-strong">Sign in</Link>
        </div>
        {features.demo ? <p className="mt-4 text-xs text-text-3">This instance runs in demo mode with a clearly fictional dataset.</p> : null}
        <div className="mt-16 grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-3">
          {[
            [Network, "Explore", "A zoomable graph of niches, creators and topics with explainable relations."],
            [Search, "Search", "Hybrid keyword + semantic search across channels, videos and transcripts."],
            [Sparkles, "Discover", "Find real channels with the YouTube Data API — quota-aware by design."],
          ].map(([Icon, title, body]) => {
            const I = Icon as typeof Network;
            return (
              <div key={title as string} className="rounded-card border border-border bg-bg-1/70 p-4">
                <I className="mb-2 size-4 stroke-[1.5] text-accent-400" />
                <div className="text-sm font-medium text-text-1">{title as string}</div>
                <div className="mt-1 text-[13px] text-text-2">{body as string}</div>
              </div>
            );
          })}
        </div>
      </section>
      <footer className="px-6 py-4 text-center text-xs text-text-3">
        Uses the YouTube Data API. Not affiliated with YouTube. · <Link href="/terms" className="hover:text-text-1">Terms</Link> · <Link href="/privacy" className="hover:text-text-1">Privacy</Link>
      </footer>
    </main>
  );
}
