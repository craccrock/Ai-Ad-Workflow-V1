"use client";

import { Toaster as Sonner } from "sonner";

/** Toasts in the navy/cream palette — no white popups. */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      theme="dark"
      toastOptions={{
        classNames: {
          toast: "!bg-surface !text-cream !border !border-hairline !rounded-[8px] !font-sans !shadow-2xl",
          description: "!text-cream-2",
          actionButton: "!bg-gold !text-navy",
          cancelButton: "!bg-elevated !text-cream",
          success: "[&_[data-icon]]:!text-success",
          error: "[&_[data-icon]]:!text-danger",
        },
      }}
    />
  );
}
