"use client";

import { AnimatedGlobe } from "@/components/animated-globe";

/** Shared, accessible loading treatment for auth and Dev Hub route transitions. */
export function DevHubLoading({
  className = "",
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <section
      aria-busy="true"
      aria-label="Loading Autheo Dev Hub"
      className={`relative isolate flex w-full items-center justify-center overflow-hidden ${compact ? "min-h-44" : "min-h-[60vh]"} ${className}`}
    >
      <div className={`relative ${compact ? "h-44 w-44 sm:h-56 sm:w-56" : "h-60 w-60 sm:h-80 sm:w-80 lg:h-[30rem] lg:w-[30rem]"}`}>
        <div className="absolute inset-[8%] rounded-full bg-indigo-500/10 blur-3xl dark:bg-cyan-400/10" aria-hidden="true" />
        <AnimatedGlobe className="absolute inset-0 h-full w-full" />
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <span className={`max-w-[15rem] text-center font-semibold tracking-[-0.04em] text-fg/90 mix-blend-multiply dark:mix-blend-screen ${compact ? "text-xl sm:text-2xl" : "text-3xl sm:text-4xl lg:text-5xl"}`}>
          Autheo Dev Hub
        </span>
      </div>
      <span className="sr-only">Loading Autheo Dev Hub</span>
    </section>
  );
}
