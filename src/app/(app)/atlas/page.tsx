import { Suspense } from "react";
import type { Metadata } from "next";
import { AtlasWorkspace } from "@/components/atlas/AtlasWorkspace";

export const metadata: Metadata = { title: "Atlas" };

export default function AtlasPage() {
  return (
    <Suspense>
      <AtlasWorkspace />
    </Suspense>
  );
}
