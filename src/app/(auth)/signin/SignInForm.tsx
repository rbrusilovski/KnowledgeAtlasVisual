"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signIn, signUp } from "@/lib/auth-client";

export function SignInForm({ github, google, demo }: { github: boolean; google: boolean; demo: boolean }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/atlas";
  const qc = useQueryClient();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = mode === "signin" ? await signIn.email({ email, password }) : await signUp.email({ email, password, name: name || email.split("@")[0]! });
    setBusy(false);
    if (r.error) return setError(r.error.message ?? "Authentication failed");
    await qc.invalidateQueries();
    router.push(next.startsWith("/") ? next : "/atlas");
    router.refresh();
  };

  return (
    <div className="overlay w-full max-w-sm rounded-panel p-6">
      <Link href="/" className="mb-6 flex items-center gap-2 text-md font-semibold text-text-1">
        <span className="size-2.5 rounded-full bg-accent-500 ring-2 ring-accent-500/30" /> Atlas
      </Link>
      <h1 className="text-xl text-text-1">{mode === "signin" ? "Welcome back" : "Create your account"}</h1>
      <p className="mt-1 text-sm text-text-2">{mode === "signin" ? "Sign in to your research workspace." : "Your first workspace is created automatically."}</p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        {mode === "signup" ? (
          <label className="block space-y-1 text-sm text-text-2">
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" name="name" />
          </label>
        ) : null}
        <label className="block space-y-1 text-sm text-text-2">
          Email
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" name="email" />
        </label>
        <label className="block space-y-1 text-sm text-text-2">
          Password
          <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} name="password" />
        </label>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
        </Button>
      </form>
      {github || google ? (
        <div className="mt-4 space-y-2">
          <div className="text-center text-xs text-text-3">or continue with</div>
          <div className="flex gap-2">
            {github ? (
              <Button variant="secondary" className="flex-1" onClick={() => void signIn.social({ provider: "github", callbackURL: next })}>
                GitHub
              </Button>
            ) : null}
            {google ? (
              <Button variant="secondary" className="flex-1" onClick={() => void signIn.social({ provider: "google", callbackURL: next })}>
                Google
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <p className="mt-5 text-center text-sm text-text-3">
        {mode === "signin" ? "New here? " : "Already have an account? "}
        <button className="text-accent-300 hover:underline" onClick={() => (setMode(mode === "signin" ? "signup" : "signin"), setError(null))}>
          {mode === "signin" ? "Create an account" : "Sign in"}
        </button>
      </p>
      {demo ? <p className="mt-3 text-center text-xs text-text-3">Demo mode: the atlas shows a fictional dataset.</p> : null}
    </div>
  );
}
