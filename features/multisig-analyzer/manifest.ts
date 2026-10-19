import { ShieldCheck } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "multisig-analyzer",
  title: "Multisig Signature Weight Analyzer",
  description: "Verify envelope signatures and find the signature weight missing for each source.",
  character: "Let's check the details before you act.",
  category: "transactions",
  status: "working",
  icon: ShieldCheck,
  networks: ["testnet", "mainnet"],
  keywords: ["multisig-analyzer", "account", "multisig", "Stellar"]
};
