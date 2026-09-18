import { DevHubLoading } from "@/components/dev-hub-loading";

// The ROOT loading boundary — Next.js uses this as the fallback for EVERY route
// under app/ (marketing pages, docs, sign-in, the dashboard…) that doesn't define
// a more specific `loading.tsx` of its own. There are no route groups in this
// tree (every top-level folder — /docs, /pricing, /admin, /workflows, … — is a
// flat sibling of this file), so this MUST stay generic/neutral rather than
// shaped like any one page — a dashboard-grid skeleton flashing on `/docs` or
// `/sign-in` would be worse than no skeleton at all. Routes with real, heavy,
// data-driven layouts (the dashboard home, workflows, a project, deployments,
// network, storage, observability) get their own accurately-shaped
// `loading.tsx` alongside their `page.tsx`, which takes precedence here.
export default function Loading() {
  return <DevHubLoading compact />;
}
