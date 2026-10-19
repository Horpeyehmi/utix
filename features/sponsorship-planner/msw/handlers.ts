import { http, HttpResponse } from "msw";
import { accountJson, ledgerJson } from "../fixtures/sponsorshipPlanner.fixture";
export const handlers = [
  http.get(/https:\/\/horizon(-testnet)?\.stellar\.org\/accounts\/[^/]+$/, ({ request }) => HttpResponse.json(accountJson(new URL(request.url).pathname.split("/").at(-1)!))),
  http.get(/https:\/\/horizon(-testnet)?\.stellar\.org\/ledgers/, () => HttpResponse.json(ledgerJson))
];
