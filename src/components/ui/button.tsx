import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control text-sm font-medium transition-colors duration-[var(--duration-micro)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.5]",
  {
    variants: {
      variant: {
        primary: "bg-accent-500 text-white hover:bg-accent-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]",
        secondary: "border border-border bg-bg-2 text-text-1 hover:bg-bg-3 hover:border-border-strong",
        ghost: "text-text-2 hover:bg-bg-3 hover:text-text-1",
        danger: "bg-danger/90 text-white hover:bg-danger",
        outline: "border border-border text-text-2 hover:text-text-1 hover:border-border-strong",
      },
      size: { sm: "h-7 px-2.5 text-xs", md: "h-8 px-3", lg: "h-10 px-4 text-base", icon: "size-8", iconSm: "size-7" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = "Button";
