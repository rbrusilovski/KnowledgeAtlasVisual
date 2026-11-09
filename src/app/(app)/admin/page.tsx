import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getSessionUser } from "@/server/session";
import { AdminPage } from "@/components/pages/Admin";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getSessionUser(await headers());
  if (user?.role !== "ADMIN") notFound();
  return <AdminPage />;
}
