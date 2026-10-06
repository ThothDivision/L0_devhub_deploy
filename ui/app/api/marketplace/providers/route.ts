import { NextResponse } from "next/server";
import { marketplaceDeploymentUrl } from "@/lib/marketplace-deployment-server";

type Listing = {
  listing_id: string;
  title: string;
  resource_type: string;
  region: string;
  provider: { provider_id: string; display_name: string; verification_state: string };
  technical_health: string;
  purchasable: boolean;
  price: { amount_theo: string; unit: string };
};

function eligible(value: unknown): value is Listing {
  if (!value || typeof value !== "object") return false;
  const listing = value as Partial<Listing>;
  return typeof listing.listing_id === "string" && typeof listing.title === "string"
    && typeof listing.resource_type === "string" && typeof listing.region === "string"
    && listing.provider?.verification_state === "verified"
    && typeof listing.provider.provider_id === "string" && typeof listing.provider.display_name === "string"
    && listing.technical_health === "healthy" && listing.purchasable === true
    && typeof listing.price?.amount_theo === "string" && typeof listing.price.unit === "string";
}

export async function GET() {
  try {
    const url = marketplaceDeploymentUrl();
    const response = await fetch(`${url}/v1/marketplace/listings?limit=50`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("marketplace unavailable");
    const body = await response.json() as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error("invalid response");
    const offers = body.data.filter(eligible).map((listing) => ({
      listing_id: listing.listing_id,
      title: listing.title,
      resource_type: listing.resource_type,
      region: listing.region,
      provider_id: listing.provider.provider_id,
      provider_name: listing.provider.display_name,
      price_theo: listing.price.amount_theo,
      price_unit: listing.price.unit,
    }));
    return NextResponse.json({ offers }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Verified provider inventory unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
