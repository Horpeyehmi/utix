import { fireEvent, screen } from "@testing-library/react";
import { copy } from "../copy";
import { rawInput } from "../fixtures/offerInspector.fixture";
export function fillForm() { fireEvent.change(screen.getByLabelText(copy.formLabel), { target: { value: rawInput.accountId } }); }
