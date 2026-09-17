"use client";

import { AnimatedGlobe } from "@/components/animated-globe";

/** Dashboard empty state with an animated, location-pinned mesh globe. */
export function GlobeEmptyState({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="relative w-full overflow-hidden">
      {(title || desc) && (
        <div className="relative z-10 pt-2">
          {title ? <h2 className="text-2xl font-semibold tracking-tight text-fg">{title}</h2> : null}
          {desc ? <p className="mt-1.5 text-sm text-secondary">{desc}</p> : null}
        </div>
      )}
      <div className="pointer-events-none relative mt-5 h-52 overflow-hidden sm:h-60">
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-[radial-gradient(ellipse_at_center_bottom,rgba(14,165,233,0.13),transparent_65%)]" />
        <AnimatedGlobe className="absolute inset-0 h-full w-full select-none" />
        <div className="absolute inset-x-[12%] bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-400/30 to-transparent" />
      </div>
    </div>
  );
}
