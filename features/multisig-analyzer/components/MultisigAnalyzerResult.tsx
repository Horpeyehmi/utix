import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { DataList } from "@/core/ui/DataList";
import { copy } from "../copy";
import { checkLabel } from "../lib/format";
import type { MultisigAnalyzerResult as Value } from "../types";

export function MultisigAnalyzerResult({ result }: { result: Value }) {
  return <Card>
    <CardHeader><CardTitle>{copy.resultTitle}</CardTitle><p className="font-semibold text-[#172033]">{result.authorizationSatisfied ? copy.satisfied : copy.missing}</p></CardHeader>
    <DataList items={[{ label: copy.hash, value: result.transactionHash, mono: true }]} />
    {result.checks.map((check, index) => <section key={index} className="mt-6 border-t border-[#e3ebf5] pt-5" aria-labelledby={`check-${index}`}>
      <h3 id={`check-${index}`} className="font-bold text-[#172033]">{checkLabel(check)}</h3>
      <DataList items={[{ label: copy.source, value: check.accountId, mono: true }, { label: copy.level, value: copy.levels[check.level] }, { label: copy.required, value: check.required }, { label: copy.present, value: check.present }, { label: copy.shortfall, value: check.missing }]} />
      <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{copy.signerCaption}</caption>
        <thead><tr>{[copy.signer, copy.weight, copy.status].map((label) => <th scope="col" key={label} className="p-2">{label}</th>)}</tr></thead>
        <tbody>{check.signers.map((signer) => <tr key={signer.key} className="border-t border-[#e3ebf5]"><th scope="row" className="max-w-72 break-all p-2 font-mono text-xs">{signer.key}</th><td className="p-2">{signer.weight}</td><td className="p-2">{signer.weight === 0 ? copy.disabled : signer.present ? copy.verified : copy.absent}</td></tr>)}</tbody>
      </table></div>
      {check.missing > 0 && <p className="mt-3 text-sm leading-6 text-[#4e5c73]">{copy.candidates}</p>}
    </section>)}
    {(result.unusedInnerSignatures.length > 0 || result.unusedOuterSignatures.length > 0) && <div className="mt-5 space-y-2 text-sm text-[#9f342d]">
      {result.unusedInnerSignatures.length > 0 && <p>{copy.unusedInner}: {result.unusedInnerSignatures.join(", ")}</p>}
      {result.unusedOuterSignatures.length > 0 && <p>{copy.unusedOuter}: {result.unusedOuterSignatures.join(", ")}</p>}
      <p>{copy.unusedNote}</p>
    </div>}
    <p className="mt-5 text-sm leading-6 text-[#4e5c73]">{copy.note}</p>
  </Card>;
}
