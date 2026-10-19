import { HandCoins } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "sponsorship-planner",
  title: "Sponsorship and Reserve Planner",
  description: "Plan new sponsored entries and check the reserve funding each account needs.",
  character: "Let's check the details before you act.",
  category: "accounts",
  status: "working",
  icon: HandCoins,
  networks: ["testnet", "mainnet"],
  keywords: ["sponsorship-planner", "account", "reserve", "Stellar"]
};
