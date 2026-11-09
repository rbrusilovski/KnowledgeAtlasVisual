import { Suspense } from "react";
import type { Metadata } from "next";
import { features } from "@/server/env";
import { SettingsPage } from "@/components/pages/Settings";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <Suspense>
      <SettingsPage youtubeOAuth={features.youtubeOAuth} />
    </Suspense>
  );
}
