import * as React from "react";
import { cn } from "@/lib/utils";

export const fieldClass =
  "w-full rounded-[6px] bg-field border border-field-border text-cream placeholder:text-muted px-3 text-sm outline-none transition-colors focus:border-gold disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(fieldClass, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea className={cn(fieldClass, "py-2.5 leading-relaxed resize-none", className)} {...props} />;
}

export function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select className={cn(fieldClass, "h-9 appearance-none pr-8 bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 fill=%22none%22 stroke=%22%23b8b0a0%22 stroke-width=%221.5%22><path d=%22M3 4.5l3 3 3-3%22/></svg>')] bg-no-repeat bg-[right_0.6rem_center]", className)} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("block text-xs font-medium uppercase tracking-[0.08em] text-cream-2", className)} {...props} />;
}
