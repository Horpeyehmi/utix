"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { Input } from "@/core/ui/Input";
import { ENTRY_KINDS, type EntryKind, type SponsorshipPlannerRaw } from "../types";
import { copy, errorCopy } from "../copy";
import { containsSecret } from "../schema";

export function SponsorshipPlannerForm({ onSubmit, pending }: { onSubmit: (raw: SponsorshipPlannerRaw) => void; pending: boolean }) {
  const [addresses, setAddresses] = useState({ sponsor: "", accountId: "" });
  const [secrets, setSecrets] = useState({ sponsor: false, accountId: false });
  const [counts, setCounts] = useState(Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, "0"])) as Record<EntryKind, string>);
  const [sponsored, setSponsored] = useState(Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, true])) as Record<EntryKind, boolean>);
  const [sponsorAccount, setSponsorAccount] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!secrets.sponsor && !secrets.accountId) onSubmit({ ...addresses, counts, sponsored, sponsorAccount });
  }
  return <form onSubmit={submit} className="space-y-5" noValidate>
    {(["sponsor", "accountId"] as const).map((key) => <Field key={key} label={key === "sponsor" ? copy.sponsor : copy.account} hint={copy.addressHint} error={secrets[key] ? errorCopy.secret_key.description : null}>
      {({ inputId, describedBy, invalid }) => <Input id={inputId} value={addresses[key]} aria-describedby={describedBy} aria-invalid={invalid} autoComplete="off" spellCheck={false} className="font-mono"
        onChange={(event) => { const value = event.target.value; const secret = containsSecret(value); setSecrets((old) => ({ ...old, [key]: secret })); setAddresses((old) => ({ ...old, [key]: secret ? "" : value })); }} />}
    </Field>)}
    <fieldset className="space-y-4"><legend className="font-bold text-[#172033]">{copy.planned}</legend>
      <p className="text-sm leading-6 text-[#4e5c73]">{copy.countsHint}</p>
      {ENTRY_KINDS.map((kind) => <div key={kind} className="flex flex-wrap items-center gap-4">
        <Field label={copy.kinds[kind]} className="w-40">{({ inputId }) => <Input id={inputId} type="number" min="0" max="10000" step="1" value={counts[kind]} onChange={(event) => setCounts((old) => ({ ...old, [kind]: event.target.value }))} />}</Field>
        <label className="flex min-h-11 items-center gap-2 text-sm text-[#172033]"><input type="checkbox" checked={sponsored[kind]} onChange={(event) => setSponsored((old) => ({ ...old, [kind]: event.target.checked }))} />{copy.sponsorKind(copy.kinds[kind])}</label>
      </div>)}
    </fieldset>
    <div><label className="flex min-h-11 items-center gap-2 text-sm text-[#172033]"><input type="checkbox" checked={sponsorAccount} onChange={(event) => setSponsorAccount(event.target.checked)} />{copy.sponsorAccount}</label><p className="text-sm leading-6 text-[#4e5c73]">{copy.accountHint}</p></div>
    <Button type="submit" disabled={pending || secrets.sponsor || secrets.accountId}>{pending ? copy.loading : copy.submit}</Button>
  </form>;
}
