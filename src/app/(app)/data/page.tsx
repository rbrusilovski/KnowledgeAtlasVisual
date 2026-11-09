import { Suspense } from "react";
import type { Metadata } from "next";
import { DataPage } from "@/components/pages/Data";

export const metadata: Metadata = { title: "Data coverage" };

export default function Page() {
  return (
    <Suspense>
      <DataPage />
    </Suspense>
  );
}
