import { notFound } from "next/navigation";
import { GraphBench } from "./GraphBench";

export const metadata = { title: "Graph bench" };

/** Dev-only performance page: 10k synthetic nodes + FPS meter. */
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <GraphBench />;
}
