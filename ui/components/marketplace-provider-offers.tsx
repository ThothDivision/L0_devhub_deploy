"use client";

import { useEffect, useState } from "react";

type Offer = {
  listing_id: string;
  title: string;
  resource_type: string;
  region: string;
  provider_id: string;
  provider_name: string;
  price_theo: string;
  price_unit: string;
};

export function MarketplaceProviderOffers() {
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/marketplace/providers", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return response.json() as Promise<{ offers: Offer[] }>;
      })
      .then((body) => setOffers(body.offers))
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, []);

  return (
    <div className="mt-5 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Verified provider supply</h3>
      <p className="mt-1 text-xs text-secondary">Read-only live offers. Choosing a provider or friend-hosted node requires an order-bound placement lease; this view does not reserve capacity or deploy a workload.</p>
      {!offers && !error && <p className="mt-2 text-xs text-secondary">Checking eligible nodes…</p>}
      {error && <p className="mt-2 text-xs text-secondary">Live inventory is unavailable. No fallback or demo nodes are shown.</p>}
      {offers?.length === 0 && <p className="mt-2 text-xs text-secondary">No verified healthy providers are offering capacity right now.</p>}
      {!!offers?.length && <ul className="mt-3 grid gap-2 sm:grid-cols-2">{offers.map((offer) => (
        <li key={offer.listing_id} className="rounded-md border border-border p-3 text-xs">
          <strong className="text-fg">{offer.provider_name}</strong> · {offer.region}
          <p className="mt-1 text-secondary">{offer.title} · {offer.resource_type}</p>
          <p className="mt-1 text-secondary">{offer.price_theo} THEO / {offer.price_unit}</p>
        </li>
      ))}</ul>}
    </div>
  );
}
