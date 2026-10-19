import { fireEvent, screen } from "@testing-library/react";
import { copy } from "../copy";
import { rawInput } from "../fixtures/sponsorshipPlanner.fixture";
export function fillForm() { fireEvent.change(screen.getByLabelText(copy.sponsor), { target: { value: rawInput.sponsor } });
  fireEvent.change(screen.getByLabelText(copy.account), { target: { value: rawInput.accountId } }); }
