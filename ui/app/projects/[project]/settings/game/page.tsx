import { Suspense } from "react";
import { PageSkeleton } from "@/components/page-skeleton";
import { GameSettings as GameSettingsClient } from "./game-settings-client";

export default function GameSettings(props: { params: Promise<{ project: string }> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <GameSettingsClient paramsPromise={props.params} />
    </Suspense>
  );
}
