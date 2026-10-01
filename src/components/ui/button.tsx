import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-sans text-sm transition-colors disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** Understated default, like "Get in touch" on madaketbrands.com */
        underline:
          "text-cream border-b border-cream/40 rounded-none px-1 pb-0.5 hover:bg-white/5 hover:border-cream",
        /** The one bold element on the page */
        gold: "bg-gold text-navy font-medium rounded-[8px] hover:bg-gold-hover shadow-[0_0_0_1px_rgba(196,168,124,0.4)]",
        ghost: "text-cream-2 rounded-[6px] hover:bg-white/5 hover:text-cream",
        outline: "text-cream border border-field-border rounded-[6px] hover:bg-white/5",
        danger: "text-danger border border-danger/40 rounded-[6px] hover:bg-danger/10",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-12 px-6 text-base",
        icon: "size-8 p-0",
        inline: "h-auto",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), variant === "underline" && "h-auto", className)} {...props} />;
}

export { buttonVariants };
