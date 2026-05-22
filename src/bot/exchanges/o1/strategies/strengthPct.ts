import type { O1EmaAtrTrailStrategyParams } from "../types";

export type O1StrengthCalcDebug = {
  direction: "long" | "short";
  currentClose: number;
  lookbackCloses: number[];
  lookbackCandleTs: number[];
  lookbackCandles: number;
  highestClose: number;
  lowestClose: number;
  selectedReferenceClose: number;
  selectedReferenceCandleTs: number;
  formula: string;
  strengthPct: number | null;
};

export type O1StrengthCalcResult = {
  strengthPct: number | null;
  debug: O1StrengthCalcDebug | null;
};

const roundStrength = (value: number): number => Math.round(value * 1e6) / 1e6;

export const computeStrengthPct = (
  side: "long" | "short",
  closes: number[],
  candleTs: number[],
  strengthLookbackCandles: number
): O1StrengthCalcResult => {
  if (closes.length < strengthLookbackCandles + 1 || candleTs.length < strengthLookbackCandles + 1) {
    return { strengthPct: null, debug: null };
  }

  const currentClose = closes[closes.length - 1]!;
  const refCloses = closes.slice(-(strengthLookbackCandles + 1), -1);
  const refCandleTs = candleTs.slice(-(strengthLookbackCandles + 1), -1);

  if (refCloses.length === 0 || !Number.isFinite(currentClose) || currentClose <= 0) {
    return { strengthPct: null, debug: null };
  }

  const highestClose = Math.max(...refCloses);
  const lowestClose = Math.min(...refCloses);
  const referenceClose = side === "long" ? lowestClose : highestClose;
  const referenceIdx = side === "long" ? refCloses.indexOf(lowestClose) : refCloses.indexOf(highestClose);
  const selectedReferenceCandleTs = refCandleTs[referenceIdx >= 0 ? referenceIdx : refCandleTs.length - 1]!;

  if (side === "long") {
    const strengthPct = roundStrength((Math.abs(currentClose - referenceClose) / currentClose) * 100);
    return {
      strengthPct,
      debug: {
        direction: "long",
        currentClose,
        lookbackCloses: refCloses,
        lookbackCandleTs: refCandleTs,
        lookbackCandles: strengthLookbackCandles,
        highestClose,
        lowestClose,
        selectedReferenceClose: referenceClose,
        selectedReferenceCandleTs,
        formula: "abs(currentClose - lowestCloseInPriorLookback) / currentClose * 100",
        strengthPct,
      },
    };
  }

  const strengthPct = roundStrength((Math.abs(referenceClose - currentClose) / currentClose) * 100);
  return {
    strengthPct,
    debug: {
      direction: "short",
      currentClose,
      lookbackCloses: refCloses,
      lookbackCandleTs: refCandleTs,
      lookbackCandles: strengthLookbackCandles,
      highestClose,
      lowestClose,
      selectedReferenceClose: referenceClose,
      selectedReferenceCandleTs,
      formula: "abs(highestCloseInPriorLookback - currentClose) / currentClose * 100",
      strengthPct,
    },
  };
};

export const getStrengthPct = (
  side: "long" | "short",
  closes: number[],
  params: Pick<O1EmaAtrTrailStrategyParams, "strengthLookbackCandles">,
  candleTs?: number[]
): number | null => {
  const ts = candleTs ?? closes.map((_, index) => index);
  return computeStrengthPct(side, closes, ts, params.strengthLookbackCandles).strengthPct;
};

export const strengthDetailsForCrossover = (
  debug: O1StrengthCalcDebug | null | undefined
): Record<string, unknown> => {
  if (!debug) return {};
  return {
    strengthLookbackCloses: debug.lookbackCloses,
    strengthLookbackCandleTs: debug.lookbackCandleTs,
    strengthSelectedReferenceClose: debug.selectedReferenceClose,
    strengthSelectedReferenceCandleTs: debug.selectedReferenceCandleTs,
    strengthHighestClose: debug.highestClose,
    strengthLowestClose: debug.lowestClose,
    strengthFormula: debug.formula,
  };
};
