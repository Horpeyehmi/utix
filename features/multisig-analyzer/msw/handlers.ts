import { http, HttpResponse } from "msw";
import { accountJson } from "../fixtures/multisigAnalyzer.fixture";
export const handlers = [
  http.get(/https:\/\/horizon(-testnet)?\.stellar\.org\/accounts\/[^/]+$/, ({ request }) => HttpResponse.json(accountJson(new URL(request.url).pathname.split("/").at(-1)!)))
];
