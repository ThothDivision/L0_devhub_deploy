import { DevHubLoading } from "@/components/dev-hub-loading";

/** Shared dashboard route-transition fallback. */
export function PageSkeleton() {
  return (
    <DevHubLoading compact />
  );
}
