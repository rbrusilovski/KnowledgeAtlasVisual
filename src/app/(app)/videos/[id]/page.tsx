import { Suspense } from "react";
import type { Metadata } from "next";
import { VideoPage } from "@/components/pages/Video";

export const metadata: Metadata = { title: "Video" };
export default async function Page({ params }: PageProps<"/videos/[id]">) {
  const { id } = await params;
  return (
    <Suspense>
      <VideoPage id={decodeURIComponent(id)} />
    </Suspense>
  );
}
