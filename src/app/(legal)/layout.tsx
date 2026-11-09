import Link from "next/link";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-bg-0">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <Link href="/" className="text-sm text-text-3 hover:text-text-1">← Atlas</Link>
        <div className="mt-6 rounded-card border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning" role="note">
          Template — the operator of this Atlas instance must review and adapt this document before publishing it.
        </div>
        <article className="prose-atlas mt-8 space-y-4 text-[15px] leading-relaxed text-text-2 [&_h1]:text-2xl [&_h1]:text-text-1 [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:text-text-1 [&_li]:ml-5 [&_li]:list-disc [&_a]:text-accent-300">{children}</article>
      </div>
    </main>
  );
}
