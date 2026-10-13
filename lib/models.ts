import type { Market } from "./types";

/** Models are not advertised as trained until an independently checked artifact exists. */
export const MODEL_STATUS = {
  status: "unavailable" as const,
  name: "Independent sports model",
  reason: "No trained, held-out calibrated model is connected. Rankings use current market-implied probabilities.",
  trainingGames: 0,
  brierScore: null,
  logLoss: null,
};

export interface BinaryEstimate {
  yes: number;
  no: number;
  method: string;
  yesSpread: number | null;
  noSpread: number | null;
}

const validPrice = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function spread(bid: number | null, ask: number | null): number | null {
  return validPrice(bid) && validPrice(ask) && ask >= bid ? ask - bid : null;
}

/** Normalize two binary midpoint prices. This is a market proxy, never model confidence. */
export function estimateBinaryMarket(market: Market): BinaryEstimate | null {
  if (market.probabilityBasis !== "market-implied" || market.settlement.type !== "binary") return null;
  const { yesBid, yesAsk, noBid, noAsk } = market;
  if ([yesBid, yesAsk, noBid, noAsk].some((quote) => quote !== null && !validPrice(quote))) return null;
  if ((validPrice(yesBid) && validPrice(yesAsk) && yesBid > yesAsk) ||
      (validPrice(noBid) && validPrice(noAsk) && noBid > noAsk)) return null;
  const yesSpread = spread(yesBid, yesAsk);
  const noSpread = spread(noBid, noAsk);
  let yes: number;
  let method: string;
  if (yesSpread !== null && noSpread !== null &&
      validPrice(yesBid) && validPrice(yesAsk) && validPrice(noBid) && validPrice(noAsk)) {
    const yesMid = (yesBid + yesAsk) / 2;
    const noMid = (noBid + noAsk) / 2;
    if (yesMid + noMid <= 0) return null;
    yes = yesMid / (yesMid + noMid);
    method = "Normalized binary bid/ask midpoints";
  } else if (validPrice(market.probability) && market.probabilityMethod) {
    // An adapter may use genuine normalized outcome prices when a full book is unavailable.
    // Its exact method must be supplied and shown to the user.
    yes = market.probability;
    method = market.probabilityMethod;
  } else {
    return null;
  }
  // Locked 0/1 instruments are not useful open selections; they often await settlement.
  if (yes <= 0 || yes >= 1) return null;
  return { yes, no: 1 - yes, method, yesSpread, noSpread };
}

/** Dependence bounds given assumed marginals, not calibrated probability intervals. */
export function frechetBounds(probabilities: number[]): { lowerBound: number; upperBound: number } {
  if (probabilities.length === 0) return { lowerBound: 0, upperBound: 0 };
  if (probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
    throw new RangeError("Marginal probabilities must be finite numbers between zero and one.");
  }
  return {
    lowerBound: Math.max(0, probabilities.reduce((sum, p) => sum + p, 0) - (probabilities.length - 1)),
    upperBound: Math.min(...probabilities),
  };
}
