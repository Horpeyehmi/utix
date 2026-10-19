import { FeeBumpTransaction, Keypair, MuxedAccount, SignerKey, StrKey, TransactionBuilder, hash, xdr, type Operation, type Transaction } from "@stellar/stellar-sdk";
import { horizonUrl } from "@/core/horizon/client";
import { NETWORK_PASSPHRASES } from "@/core/network/config";
import type { StellarNetwork } from "@/core/network/types";
import { err, ok, type Result } from "@/core/result/result";
import { parseMultisigAnalyzerInput } from "../schema";
import type { AuthorizationCheck, MultisigAnalyzerInput, MultisigAnalyzerResult, MultisigAnalyzerErrorCode, ThresholdLevel, VerifiedSigner } from "../types";
import { requestJson, record, integer, InvalidResponse } from "./horizon";
import { toMultisigAnalyzerErrorCode } from "./multisigAnalyzer.errors";

interface Signer { key: string; weight: number; type: number }
interface Account { signers: Signer[]; thresholds: Record<ThresholdLevel, number> }

/** SDK 13's signer decoder includes XDR padding in P-key payloads. Decode the length explicitly. */
function decodeSigner(key: string): xdr.SignerKey {
  return key.startsWith("P")
    ? xdr.SignerKey.signerKeyTypeEd25519SignedPayload(xdr.SignerKeyEd25519SignedPayload.fromXDR(StrKey.decodeSignedPayload(key)))
    : SignerKey.decodeAddress(key);
}

const LOW = new Set(["allowTrust", "bumpSequence", "claimClaimableBalance", "setTrustLineFlags", "inflation"]);
const MEDIUM = new Set(["createAccount", "payment", "pathPaymentStrictReceive", "pathPaymentStrictSend", "manageSellOffer", "manageBuyOffer", "createPassiveSellOffer", "changeTrust", "manageData", "createClaimableBalance", "beginSponsoringFutureReserves", "endSponsoringFutureReserves", "revokeSponsorship", "clawback", "clawbackClaimableBalance", "liquidityPoolDeposit", "liquidityPoolWithdraw", "invokeHostFunction", "extendFootprintTtl", "restoreFootprint"]);

export function operationThreshold(operation: Operation): ThresholdLevel | null {
  if (LOW.has(operation.type)) return "low";
  if (operation.type === "accountMerge") return "high";
  if (operation.type === "setOptions") {
    return [operation.masterWeight, operation.lowThreshold, operation.medThreshold, operation.highThreshold, operation.signer].some((value) => value !== undefined) ? "high" : "medium";
  }
  return MEDIUM.has(operation.type) ? "medium" : null;
}

export function baseAccount(address: string): string {
  return StrKey.isValidEd25519PublicKey(address) ? address : MuxedAccount.fromAddress(address, "0").baseAccount().accountId();
}

function normalizeAccount(value: unknown, accountId: string): Account {
  const row = record(value), thresholds = record(row.thresholds);
  if (row.account_id !== accountId || !Array.isArray(row.signers) || row.signers.length > 21) throw new InvalidResponse();
  const keys = new Set<string>();
  const signers = row.signers.map((value): Signer => {
    const signer = record(value);
    if (typeof signer.key !== "string" || keys.has(signer.key)) throw new InvalidResponse();
    keys.add(signer.key);
    try {
      const key = decodeSigner(signer.key);
      if (SignerKey.encodeSignerKey(key) !== signer.key) throw new InvalidResponse();
      return { key: signer.key, weight: integer(signer.weight, 0, 255), type: key.switch().value };
    } catch { throw new InvalidResponse(); }
  });
  return { signers, thresholds: { low: integer(thresholds.low_threshold, 0, 255), medium: integer(thresholds.med_threshold, 0, 255), high: integer(thresholds.high_threshold, 0, 255) } };
}

function hint(bytes: Buffer): Buffer {
  if (bytes.length >= 4) return bytes.subarray(-4);
  return Buffer.concat([bytes, Buffer.alloc(4 - bytes.length)]);
}

/** Hints only select candidates. A contribution always needs cryptographic verification. */
function verifies(keyString: string, contentsHash: Buffer, signature?: xdr.DecoratedSignature): boolean {
  try {
    const key = decodeSigner(keyString);
    if (key.switch().value === 1) return key.preAuthTx().equals(contentsHash);
    if (!signature) return false;
    const bytes = signature.signature(), suppliedHint = signature.hint();
    if (key.switch().value === 0) {
      const publicKey = key.ed25519();
      return hint(publicKey).equals(suppliedHint) && Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(publicKey)).verify(contentsHash, bytes);
    }
    if (key.switch().value === 2) return hint(key.hashX()).equals(suppliedHint) && Buffer.from(hash(bytes)).equals(key.hashX());
    if (key.switch().value === 3) {
      const payload = key.ed25519SignedPayload();
      const expectedHint = hint(payload.ed25519()).map((byte, index) => byte ^ hint(payload.payload())[index]);
      return Buffer.from(expectedHint).equals(suppliedHint) && Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(payload.ed25519())).verify(payload.payload(), bytes);
    }
  } catch { return false; }
  return false;
}

function contributions(account: Account, contentsHash: Buffer, signatures: xdr.DecoratedSignature[]): VerifiedSigner[] {
  return account.signers.map((signer) => {
    const index = signatures.findIndex((signature) => verifies(signer.key, contentsHash, signature));
    const present = signer.weight > 0 && (signer.type === 1 ? verifies(signer.key, contentsHash) : index >= 0);
    return { key: signer.key, weight: signer.weight, present, signatureIndex: present && signer.type !== 1 ? index : undefined };
  });
}

/** Reproduce early stopping so duplicated or surplus signatures remain visible. */
function consume(account: Account, contentsHash: Buffer, signatures: xdr.DecoratedSignature[], required: number, used: Set<number>): void {
  let total = 0;
  for (const signer of account.signers.filter((signer) => signer.type === 1 && signer.weight > 0)) {
    if (verifies(signer.key, contentsHash)) total += signer.weight;
    if (total >= required) return;
  }
  for (const type of [2, 0, 3]) {
    const remaining = account.signers.filter((signer) => signer.type === type && signer.weight > 0);
    for (let index = 0; index < signatures.length; index++) {
      const candidate = remaining.findIndex((signer) => verifies(signer.key, contentsHash, signatures[index]));
      if (candidate < 0) continue;
      total += remaining[candidate].weight;
      used.add(index);
      remaining.splice(candidate, 1);
      if (total >= required) return;
    }
  }
}

function check(account: Account, accountId: string, level: ThresholdLevel, contentsHash: Buffer, signatures: xdr.DecoratedSignature[], used: Set<number>, kind: AuthorizationCheck["kind"]): AuthorizationCheck {
  const required = Math.max(1, account.thresholds[level]);
  const signers = contributions(account, contentsHash, signatures);
  const present = signers.reduce((sum, signer) => sum + (signer.present ? signer.weight : 0), 0);
  consume(account, contentsHash, signatures, required, used);
  return { kind, accountId, level, required, present, missing: Math.max(0, required - present), signers };
}

export async function runMultisigAnalyzer(input: MultisigAnalyzerInput, network: StellarNetwork, signal?: AbortSignal): Promise<Result<MultisigAnalyzerResult, MultisigAnalyzerErrorCode>> {
  const parsed = parseMultisigAnalyzerInput(input);
  if (!parsed.ok) return parsed;
  let envelope;
  try { envelope = TransactionBuilder.fromXDR(parsed.value.xdr, NETWORK_PASSPHRASES[network]); }
  catch { return err("invalid_xdr"); }
  const outer = envelope instanceof FeeBumpTransaction ? envelope : null;
  const feeBump = outer !== null;
  const transaction = outer ? outer.innerTransaction : envelope as Transaction;
  if (!transaction.operations.length) return err("invalid_xdr");
  if (baseAccount(transaction.source) !== parsed.value.accountId) return err("source_mismatch");
  const levels = transaction.operations.map(operationThreshold);
  if (levels.some((level) => level === null)) return err("unsupported_operation");
  try {
    const sources = [...new Set([transaction.source, ...transaction.operations.map((operation) => operation.source ?? transaction.source), ...(outer ? [outer.feeSource] : [])].map(baseAccount))];
    const accounts = new Map<string, Account>();
    // Bound concurrency for envelopes with many operation source accounts.
    for (let offset = 0; offset < sources.length; offset += 6) {
      await Promise.all(sources.slice(offset, offset + 6).map(async (source) => {
        const json = await requestJson(horizonUrl(network, `/accounts/${source}`), signal);
        accounts.set(source, normalizeAccount(json, source));
      }));
    }
    const checks: AuthorizationCheck[] = [], innerUsed = new Set<number>(), outerUsed = new Set<number>();
    const contentsHash = transaction.hash();
    const source = baseAccount(transaction.source);
    checks.push(check(accounts.get(source)!, source, "low", contentsHash, transaction.signatures, innerUsed, "transaction"));
    // Read typed XDR directly: SDK 13 declares strings here but returns XDR signer keys at runtime.
    const encoded = transaction.toEnvelope();
    const condition = encoded.switch().value === 2 ? encoded.v1().tx().cond() : null;
    const extraSigners = condition?.switch().value === 2 ? condition.v2().extraSigners() : [];
    for (const signer of extraSigners) {
      const extra = SignerKey.encodeSignerKey(signer);
      const account: Account = { signers: [{ key: extra, weight: 1, type: signer.switch().value }], thresholds: { low: 1, medium: 1, high: 1 } };
      checks.push(check(account, extra, "low", contentsHash, transaction.signatures, innerUsed, "extra"));
    }
    transaction.operations.forEach((operation, index) => {
      const source = baseAccount(operation.source ?? transaction.source);
      checks.push({ ...check(accounts.get(source)!, source, levels[index]!, contentsHash, transaction.signatures, innerUsed, "operation"), operation: index + 1, operationType: operation.type });
    });
    if (outer) {
      const source = baseAccount(outer.feeSource);
      checks.push(check(accounts.get(source)!, source, "low", outer.hash(), outer.signatures, outerUsed, "fee"));
    }
    const unusedInnerSignatures = transaction.signatures.flatMap((_, index) => innerUsed.has(index) ? [] : [index + 1]);
    const unusedOuterSignatures = outer ? outer.signatures.flatMap((_, index) => outerUsed.has(index) ? [] : [index + 1]) : [];
    return ok({ accountId: source, transactionHash: contentsHash.toString("hex"), feeBump, checks, unusedInnerSignatures, unusedOuterSignatures,
      authorizationSatisfied: checks.every((check) => check.missing === 0) && unusedInnerSignatures.length === 0 && unusedOuterSignatures.length === 0 });
  } catch (error) { return err(toMultisigAnalyzerErrorCode(error)); }
}
