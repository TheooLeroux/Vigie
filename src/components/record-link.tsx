"use client";
import type { ReactNode } from "react";

export function RecordLink({
  href,
  onNavigate,
  children,
  className = "",
  stretch = false,
}: {
  href: string;
  onNavigate: () => void;
  children: ReactNode;
  className?: string;
  stretch?: boolean;
}) {
  return (
    <a
      href={href}
      className={`${stretch ? "record-link" : ""} ${className}`}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onNavigate();
      }}
    >
      {children}
    </a>
  );
}
