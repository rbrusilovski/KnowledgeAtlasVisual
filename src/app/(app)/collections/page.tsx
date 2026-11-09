import type { Metadata } from "next";
import { CollectionsPage } from "@/components/pages/Collections";

export const metadata: Metadata = { title: "Collections" };
export default function Page() {
  return <CollectionsPage />;
}
