import type { Metadata } from "next";
import { CollectionDetailPage } from "@/components/pages/Collections";

export const metadata: Metadata = { title: "Collection" };
export default async function Page({ params }: PageProps<"/collections/[id]">) {
  const { id } = await params;
  return <CollectionDetailPage id={id} />;
}
