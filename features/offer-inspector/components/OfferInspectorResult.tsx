import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { DataList } from "@/core/ui/DataList";
import { Button } from "@/core/ui/Button";
import { formatAmount } from "@/core/format/amount";
import { copy } from "../copy";
import { formatPrice, reserveTotals } from "../lib/format";
import type { OfferInspectorResult as Value } from "../types";

export function OfferInspectorResult({ result, onNext }: { result: Value; onNext: () => void }) {
  const totals = reserveTotals(result.offers, result.baseReserveStroops);
  return <Card>
    <CardHeader><CardTitle>{copy.resultTitle}</CardTitle></CardHeader>
    {!result.offers.length ? <p>{copy.noOffers}</p> : <>
      <div className="overflow-x-auto"><table className="w-full min-w-[52rem] text-left text-sm">
        <caption className="sr-only">{copy.caption}</caption>
        <thead><tr>{[copy.id, copy.selling, copy.buying, copy.amount, copy.price, copy.reserve, copy.payer].map((label) => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
        <tbody>{result.offers.map((offer) => <tr key={offer.id} className="border-t border-[#e3ebf5]">
          <th scope="row" className="p-2 font-mono">{offer.id}</th>
          {[offer.selling, offer.buying].map((asset, index) => <td key={index} className="p-2"><span>{asset.code}</span>{asset.issuer && <span className="mt-1 block max-w-44 break-all font-mono text-xs">{asset.issuer}</span>}</td>)}
          <td className="p-2 font-mono">{formatAmount(offer.amount)}</td>
          <td className="p-2 font-mono">{formatPrice(offer)}</td>
          <td className="p-2 font-mono">{formatAmount(BigInt(result.baseReserveStroops))}</td>
          <td className="p-2">{offer.sponsor ? <><span>{copy.sponsoredBy}</span><span className="mt-1 block max-w-44 break-all font-mono text-xs">{offer.sponsor}</span></> : copy.accountPays}</td>
        </tr>)}</tbody>
      </table></div>
      <DataList items={[{ label: copy.ownReserve, value: `${totals.account} ${copy.xlm}` }, { label: copy.sponsoredReserve, value: `${totals.sponsored} ${copy.xlm}` }]} />
    </>}
    <p className="mt-4 text-sm leading-6 text-[#4e5c73]">{copy.note}</p>
    {result.nextCursor && <Button className="mt-4" variant="secondary" onClick={onNext}>{copy.next}</Button>}
    {result.cursor && <p className="mt-3 text-sm text-[#4e5c73]">{copy.first}</p>}
  </Card>;
}
