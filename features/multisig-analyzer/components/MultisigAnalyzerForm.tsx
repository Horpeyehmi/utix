"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { Input, Textarea } from "@/core/ui/Input";
import type { MultisigAnalyzerRaw } from "../types";
import { containsSecret } from "../schema";
import { copy, errorCopy } from "../copy";

export function MultisigAnalyzerForm({ onSubmit, pending }: { onSubmit: (raw: MultisigAnalyzerRaw) => void; pending: boolean }) {
  const [values, setValues] = useState({ accountId: "", xdr: "" });
  const [secrets, setSecrets] = useState({ accountId: false, xdr: false });
  function update(key: "accountId" | "xdr", value: string) {
    const secret = containsSecret(value);
    setSecrets((old) => ({ ...old, [key]: secret }));
    setValues((old) => ({ ...old, [key]: secret ? "" : value }));
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!secrets.accountId && !secrets.xdr) onSubmit(values); }
  return <form onSubmit={submit} className="space-y-4" noValidate>
    <Field label={copy.account} hint={copy.accountHint} error={secrets.accountId ? errorCopy.secret_key.description : null}>
      {({ inputId, describedBy, invalid }) => <Input id={inputId} aria-describedby={describedBy} aria-invalid={invalid} value={values.accountId} onChange={(event) => update("accountId", event.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />}
    </Field>
    <Field label={copy.envelope} hint={copy.envelopeHint} error={secrets.xdr ? errorCopy.secret_key.description : null}>
      {({ inputId, describedBy, invalid }) => <Textarea id={inputId} aria-describedby={describedBy} aria-invalid={invalid} value={values.xdr} onChange={(event) => update("xdr", event.target.value)} autoComplete="off" spellCheck={false} maxLength={200000} />}
    </Field>
    <Button type="submit" disabled={pending || secrets.accountId || secrets.xdr}>{pending ? copy.loading : copy.submit}</Button>
  </form>;
}
