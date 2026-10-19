import { ListFilter } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "offer-inspector",
  title: "Account Offers Inspector",
  description: "List open offers, exact prices, selling amounts and reserve sponsorship.",
  character: "Let's check the details before you act.",
  category: "accounts",
  status: "working",
  icon: ListFilter,
  networks: ["testnet", "mainnet"],
  keywords: ["offer-inspector", "account", "reserve", "Stellar"]
};
