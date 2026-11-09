import type { Metadata } from "next";
import { ChannelPage } from "@/components/pages/Channel";

export const metadata: Metadata = { title: "Channel" };
export default async function Page({ params }: PageProps<"/channels/[id]">) {
  const { id } = await params;
  return <ChannelPage id={decodeURIComponent(id)} />;
}
