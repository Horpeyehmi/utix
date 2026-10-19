import { http, HttpResponse } from "msw";
import { offersJson, ledgerJson } from "../fixtures/offerInspector.fixture";
export const handlers = [
  http.get(/https:\/\/horizon(-testnet)?\.stellar\.org\/accounts\/[^/]+\/offers/, () => HttpResponse.json(offersJson)),
  http.get(/https:\/\/horizon(-testnet)?\.stellar\.org\/ledgers/, () => HttpResponse.json(ledgerJson))
];
