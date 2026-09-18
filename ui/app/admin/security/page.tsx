import { Suspense } from "react";
import { PageSkeleton } from "@/components/page-skeleton";
import { fetchOpsServer } from "@/lib/ops-data";
import type { SecurityPosture } from "@/lib/api";
import { SecurityPostureClient } from "./security-posture-client";

export default function SecurityPosturePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SecurityPostureData />
    </Suspense>
  );
}

async function SecurityPostureData() {
  const initial = await fetchOpsServer<SecurityPosture>("/v1/security/posture").catch(() => null);
  return <SecurityPostureClient initial={initial} />;
}
