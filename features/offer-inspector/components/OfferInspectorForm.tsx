"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { Input } from "@/core/ui/Input";
import type { OfferInspectorRaw } from "../types";
import { containsSecret } from "../schema";
import { copy, errorCopy } from "../copy";

export function OfferInspectorForm({ onSubmit, pending }: { onSubmit: (raw: OfferInspectorRaw) => void; pending: boolean }) {
  const [accountId, setAccountId] = useState("");
  const [secret, setSecret] = useState(false);
  function submit(event: FormEvent) { event.preventDefault(); if (!secret) onSubmit({ accountId }); }
  return <form onSubmit={submit} className="space-y-4" noValidate>
    <Field label={copy.formLabel} hint={copy.formHint} error={secret ? errorCopy.secret_key.description : null}>
      {({ inputId, describedBy, invalid }) => <Input id={inputId} aria-describedby={describedBy} aria-invalid={invalid}
        value={accountId} autoComplete="off" spellCheck={false} className="font-mono"
        onChange={(event) => { const value = event.target.value; const rejected = containsSecret(value); setSecret(rejected); setAccountId(rejected ? "" : value); }} />}
    </Field>
    <Button type="submit" disabled={pending || secret}>{pending ? copy.loading : copy.submit}</Button>
  </form>;
}
