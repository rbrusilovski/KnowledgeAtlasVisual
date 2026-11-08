import Link from "next/link";

export default function Landing() {
  return (
    <main className="canvas-bg flex min-h-screen flex-col items-center justify-center px-6">
      <h1 className="text-2xl text-text-1">Atlas</h1>
      <p className="mt-3 max-w-md text-center text-md text-text-2">
        Map YouTube niches, channels, videos and topics as one explorable knowledge graph.
      </p>
      <Link
        href="/atlas"
        className="mt-8 rounded-control bg-accent-500 px-4 py-2 text-sm font-medium text-white hover:bg-accent-600"
      >
        Open the atlas
      </Link>
    </main>
  );
}
