"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { MotionConfig } from "motion/react";
import { Toaster } from "sonner";
import { useEffect, useState, type ReactNode } from "react";
import { useUi } from "@/lib/atlas/store";
import { ApiError } from "@/lib/api";

export function Providers({ children, reducedMotion }: { children: ReactNode; reducedMotion?: boolean }) {
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
        <MotionConfig reducedMotion={reducedMotion ? "always" : "user"}>
          {children}
          <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{ className: "!bg-bg-2 !border-border !text-text-1 !text-sm" }}
          />
        </MotionConfig>
      </NuqsAdapter>
    </QueryClientProvider>
  );
}
