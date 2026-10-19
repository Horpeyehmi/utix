import { fireEvent, screen } from "@testing-library/react";
import { copy } from "../copy";
import { rawInput } from "../fixtures/multisigAnalyzer.fixture";
export function fillForm() { fireEvent.change(screen.getByLabelText(copy.account), { target: { value: rawInput.accountId } });
  fireEvent.change(screen.getByLabelText(copy.envelope), { target: { value: rawInput.xdr } }); }
