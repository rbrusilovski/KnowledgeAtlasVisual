import { Suspense } from "react";
import type { Metadata } from "next";
import { DiscoverPage } from "@/components/pages/Discover";

export const metadata: Metadata = { title: "Discover" };
export default function Page() {
  return (
    <Suspense>
      <DiscoverPage />
    </Suspense>
  );
}
