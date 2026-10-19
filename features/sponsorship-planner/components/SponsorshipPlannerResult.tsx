import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { DataList } from "@/core/ui/DataList";
import { copy } from "../copy";
import { formatReserve } from "../lib/format";
import type { SponsorshipPlannerResult as Value } from "../types";

export function SponsorshipPlannerResult({ result }: { result: Value }) {
  const xlm = (value: string) => `${formatReserve(value)} ${copy.xlm}`;
  return <Card>
    <CardHeader><CardTitle>{copy.resultTitle}</CardTitle><p className="text-sm text-[#4e5c73]">{result.newAccount ? copy.newAccount : copy.existingAccount}</p></CardHeader>
    <DataList items={[
      { label: copy.base, value: xlm(result.baseReserveStroops) },
      { label: copy.units, value: result.sponsoredUnits },
      { label: copy.cost, value: xlm(result.sponsorCostStroops) },
      { label: copy.sponsorMinimum, value: xlm(result.sponsorMinimumStroops) },
      { label: copy.available, value: xlm(result.sponsorAvailableStroops) },
      { label: copy.sponsorShortfall, value: xlm(result.sponsorShortfallStroops) },
      { label: copy.accountMinimum, value: xlm(result.accountMinimumStroops) },
      { label: copy.accountShortfall, value: xlm(result.accountShortfallStroops) }
    ]} />
    <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{copy.tableCaption}</caption>
      <thead><tr>{[copy.kind, copy.count, copy.reserveUnits, copy.payer].map((label) => <th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
      <tbody>{result.entries.map((entry) => <tr key={entry.kind} className="border-t border-[#e3ebf5]"><th scope="row" className="p-2">{copy.kinds[entry.kind]}</th><td className="p-2">{entry.count}</td><td className="p-2">{entry.units}</td><td className="p-2">{entry.sponsored ? copy.sponsorPays : copy.accountPays}</td></tr>)}</tbody>
    </table></div>
    <p className="mt-4 text-sm leading-6 text-[#4e5c73]">{copy.note}</p>
  </Card>;
}
