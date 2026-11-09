"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { useEffect, useState, type ReactNode } from "react";
import { useUi } from "@/lib/atlas/store";
import { ApiError } from "@/lib/api";
import { useMe } from "@/lib/hooks";

/** Applies the signed-in user's reduced-motion preference (in addition to the OS-level prefers-reduced-motion). */
function MotionPreference({ children }: { children: ReactNode }) {
  const me = useMe();
  const reduced = Boolean(me.data?.reducedMotion);
  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduced);
  }, [reduced]);
  return <MotionConfig reducedMotion={reduced ? "always" : "user"}>{children}</MotionConfig>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
      }),
  );
  useEffect(() => {
    void useUi.persist.rehydrate();
  }, []);
  return (
    <QueryClientProvider client={client}>
      <NuqsAdapter>
        <MotionPreference>
          {children}
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{ className: "!bg-bg-2 !border-border !text-text-1 !text-sm" }}
          />
        </MotionPreference>
      </NuqsAdapter>
    </QueryClientProvider>
  );
}
