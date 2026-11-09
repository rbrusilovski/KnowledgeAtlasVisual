"use client";

import { useEffect } from "react";
import { AtlasSidebar } from "./Sidebar";
import { AtlasView } from "./AtlasView";
import { Inspector } from "@/components/inspector/Inspector";

export function AtlasWorkspace() {
  useEffect(() => {
    const prev = document.body.style.overscrollBehavior;
    document.body.style.overscrollBehavior = "none";
    return () => void (document.body.style.overscrollBehavior = prev);
  }, []);
  return (
    <>
      <AtlasSidebar />
      <AtlasView />
      <Inspector />
    </>
  );
}
