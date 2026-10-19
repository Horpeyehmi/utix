import type { AuthorizationCheck } from "../types";
import { copy } from "../copy";
export function checkLabel(check: AuthorizationCheck): string {
  return check.kind === "operation" ? copy.operation(check.operation!, check.operationType!) : copy[check.kind];
}
