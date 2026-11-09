import type { Metadata } from "next";
import { features } from "@/server/env";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <main className="canvas-bg flex min-h-dvh items-center justify-center px-4">
      <SignInForm github={features.github} google={features.google} demo={features.demo} />
    </main>
  );
}
