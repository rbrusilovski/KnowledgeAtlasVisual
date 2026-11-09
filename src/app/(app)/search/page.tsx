import { Suspense } from "react";
import type { Metadata } from "next";
import { SearchPage } from "@/components/pages/Search";

export const metadata: Metadata = { title: "Search" };
export default function Page() {
  return (
    <Suspense>
      <SearchPage />
    </Suspense>
  );
}
