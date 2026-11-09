"use client";

import { Tooltip as T, Tabs as Tb, Switch as Sw, Slider as Sl, Popover as Po, Dialog as Di, DropdownMenu as Dm, Checkbox as Cb } from "radix-ui";
import { Check, ChevronRight, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

// ── Badge / Kbd / Skeleton ────────────────────────────────────────────────
export function Badge({ className, tone = "neutral", ...p }: ComponentProps<"span"> & { tone?: "neutral" | "accent" | "success" | "warning" | "danger" }) {
  const tones = {
    neutral: "border-border bg-bg-3 text-text-2",
    accent: "border-accent-500/40 bg-accent-500/12 text-accent-300",
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-warning",
    danger: "border-danger/30 bg-danger/10 text-danger",
  } as const;
  return <span className={cn("inline-flex h-5 items-center gap-1 rounded-[5px] border px-1.5 text-xs font-medium", tones[tone], className)} {...p} />;
}

export function Kbd({ className, ...p }: ComponentProps<"kbd">) {
  return <kbd className={cn("num inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-bg-3 px-1 text-[11px] text-text-3", className)} {...p} />;
}

export function Skeleton({ className, ...p }: ComponentProps<"div">) {
  return <div aria-hidden className={cn("animate-pulse rounded-control bg-bg-3", className)} {...p} />;
}

// ── Tooltip ───────────────────────────────────────────────────────────────
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root delayDuration={300}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="overlay z-50 max-w-72 rounded-control px-2 py-1 text-xs text-text-1 data-[state=delayed-open]:animate-in">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
export const TooltipProvider = T.Provider;

// ── Tabs ──────────────────────────────────────────────────────────────────
export const Tabs = Tb.Root;
export function TabsList({ className, ...p }: ComponentProps<typeof Tb.List>) {
  return <Tb.List className={cn("flex h-9 items-center gap-1 border-b border-border px-2", className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: ComponentProps<typeof Tb.Trigger>) {
  return (
    <Tb.Trigger
      className={cn(
        "relative h-9 px-2 text-sm text-text-3 transition-colors hover:text-text-1 data-[state=active]:text-text-1 data-[state=active]:after:absolute data-[state=active]:after:inset-x-1 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent-500",
        className,
      )}
      {...p}
    />
  );
}
export const TabsContent = Tb.Content;

// ── Switch / Checkbox / Slider ────────────────────────────────────────────
export function Switch({ className, ...p }: ComponentProps<typeof Sw.Root>) {
  return (
    <Sw.Root className={cn("relative h-4.5 w-8 shrink-0 rounded-full border border-border bg-bg-3 transition-colors data-[state=checked]:border-accent-500 data-[state=checked]:bg-accent-500", className)} {...p}>
      <Sw.Thumb className="block size-3.5 translate-x-px rounded-full bg-text-1 transition-transform duration-[var(--duration-micro)] data-[state=checked]:translate-x-[15px]" />
    </Sw.Root>
  );
}
export function Checkbox({ className, ...p }: ComponentProps<typeof Cb.Root>) {
  return (
    <Cb.Root className={cn("flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border-strong bg-bg-3 data-[state=checked]:border-accent-500 data-[state=checked]:bg-accent-500", className)} {...p}>
      <Cb.Indicator>
        <Check className="size-3 stroke-[2.5] text-white" />
      </Cb.Indicator>
    </Cb.Root>
  );
}
export function Slider({ className, ...p }: ComponentProps<typeof Sl.Root>) {
  const count = (p.value ?? p.defaultValue ?? [0]).length;
  return (
    <Sl.Root className={cn("relative flex h-5 w-full touch-none select-none items-center", className)} {...p}>
      <Sl.Track className="relative h-1 grow rounded-full bg-bg-3">
        <Sl.Range className="absolute h-full rounded-full bg-accent-500" />
      </Sl.Track>
      {Array.from({ length: count }, (_, i) => (
        <Sl.Thumb key={i} aria-label={count > 1 ? (i === 0 ? "Minimum" : "Maximum") : "Value"} className="block size-3.5 rounded-full border border-accent-400 bg-bg-0 shadow focus-visible:ring-2 focus-visible:ring-accent-500" />
      ))}
    </Sl.Root>
  );
}

// ── Popover ───────────────────────────────────────────────────────────────
export const Popover = Po.Root;
export const PopoverTrigger = Po.Trigger;
export const PopoverAnchor = Po.Anchor;
export function PopoverContent({ className, align = "start", sideOffset = 6, ...p }: ComponentProps<typeof Po.Content>) {
  return (
    <Po.Portal>
      <Po.Content align={align} sideOffset={sideOffset} className={cn("overlay z-50 rounded-card p-3 text-sm outline-none", className)} {...p} />
    </Po.Portal>
  );
}

// ── Dialog ────────────────────────────────────────────────────────────────
export const Dialog = Di.Root;
export const DialogTrigger = Di.Trigger;
export const DialogClose = Di.Close;
export function DialogContent({ className, children, title, description, ...p }: ComponentProps<typeof Di.Content> & { title: string; description?: string }) {
  return (
    <Di.Portal>
      <Di.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
      <Di.Content className={cn("overlay fixed left-1/2 top-[18%] z-50 w-[min(92vw,480px)] -translate-x-1/2 rounded-panel p-5 outline-none", className)} {...p}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <Di.Title className="text-md font-semibold text-text-1">{title}</Di.Title>
            {description ? <Di.Description className="mt-1 text-sm text-text-2">{description}</Di.Description> : <Di.Description className="sr-only">{title}</Di.Description>}
          </div>
          <Di.Close className="rounded-control p-1 text-text-3 hover:bg-bg-3 hover:text-text-1" aria-label="Close">
            <X className="size-4" />
          </Di.Close>
        </div>
        {children}
      </Di.Content>
    </Di.Portal>
  );
}

// ── Dropdown menu ─────────────────────────────────────────────────────────
export const Menu = Dm.Root;
export const MenuTrigger = Dm.Trigger;
export const MenuSub = Dm.Sub;
const menuPanel = "overlay z-50 min-w-48 rounded-card p-1 text-sm";
export function MenuContent({ className, sideOffset = 6, ...p }: ComponentProps<typeof Dm.Content>) {
  return (
    <Dm.Portal>
      <Dm.Content sideOffset={sideOffset} className={cn(menuPanel, className)} {...p} />
    </Dm.Portal>
  );
}
export function MenuItem({ className, ...p }: ComponentProps<typeof Dm.Item>) {
  return <Dm.Item className={cn("flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-text-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-1 [&_svg]:size-4 [&_svg]:stroke-[1.5]", className)} {...p} />;
}
export function MenuSubTrigger({ className, children, ...p }: ComponentProps<typeof Dm.SubTrigger>) {
  return (
    <Dm.SubTrigger className={cn("flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-text-2 outline-none data-[highlighted]:bg-bg-3 data-[state=open]:bg-bg-3 data-[highlighted]:text-text-1 [&_svg]:size-4 [&_svg]:stroke-[1.5]", className)} {...p}>
      {children}
      <ChevronRight className="ml-auto" />
    </Dm.SubTrigger>
  );
}
export function MenuSubContent({ className, ...p }: ComponentProps<typeof Dm.SubContent>) {
  return (
    <Dm.Portal>
      <Dm.SubContent sideOffset={4} className={cn(menuPanel, className)} {...p} />
    </Dm.Portal>
  );
}
export function MenuSeparator() {
  return <Dm.Separator className="my-1 h-px bg-border" />;
}
export function MenuLabel({ className, ...p }: ComponentProps<typeof Dm.Label>) {
  return <Dm.Label className={cn("px-2 py-1 text-xs text-text-3", className)} {...p} />;
}
export const MenuCheckboxItem = ({ className, children, ...p }: ComponentProps<typeof Dm.CheckboxItem>) => (
  <Dm.CheckboxItem className={cn("flex h-8 cursor-default select-none items-center gap-2 rounded-[6px] px-2 text-text-2 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-1", className)} {...p}>
    <span className="flex size-4 items-center justify-center">
      <Dm.ItemIndicator>
        <Check className="size-3.5" />
      </Dm.ItemIndicator>
    </span>
    {children}
  </Dm.CheckboxItem>
);

// ── Empty / error states ──────────────────────────────────────────────────
export function EmptyState({ icon, title, body, children, className }: { icon?: ReactNode; title: string; body?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      {icon ? <div className="mb-3 flex size-10 items-center justify-center rounded-card border border-border bg-bg-2 text-text-2 [&_svg]:size-5 [&_svg]:stroke-[1.5]">{icon}</div> : null}
      <p className="text-base font-medium text-text-1">{title}</p>
      {body ? <p className="mt-1 max-w-sm text-sm text-text-2">{body}</p> : null}
      {children ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div role="alert" className={cn("flex flex-col items-center gap-3 px-6 py-8 text-center", className)}>
      <p className="text-sm text-danger">{msg}</p>
      {onRetry ? (
        <button onClick={onRetry} className="rounded-control border border-border px-3 py-1 text-sm text-text-2 hover:text-text-1">
          Retry
        </button>
      ) : null}
    </div>
  );
}
