import { computeStrengthPct } from "../bot/exchanges/o1/strategies/strengthPct";

const LOOKBACK = 5;

type Case = {
  name: string;
  side: "long" | "short";
  closes: number[];
  candleTs: number[];
  expectedStrength: number;
};

const buildCandleTs = (closes: number[], baseTs = 1_779_010_500_000): number[] => {
  return closes.map((_, index) => baseTs + index * 180_000);
};

const cases: Case[] = [
  {
    name: "long with clear upward move",
    side: "long",
    closes: [100, 101, 102, 103, 98],
    candleTs: buildCandleTs([100, 101, 102, 103, 98]),
    expectedStrength: ((103 - 98) / 98) * 100,
  },
  {
    name: "long with no move",
    side: "long",
    closes: [100, 100, 100, 100, 100],
    candleTs: buildCandleTs([100, 100, 100, 100, 100]),
    expectedStrength: 0,
  },
  {
    name: "short with clear downward move",
    side: "short",
    closes: [100, 99, 98, 97, 100],
    candleTs: buildCandleTs([100, 99, 98, 97, 100]),
    expectedStrength: ((100 - 97) / 100) * 100,
  },
  {
    name: "short with no move",
    side: "short",
    closes: [86.71, 86.71, 86.71, 86.71, 86.71],
    candleTs: buildCandleTs([86.71, 86.71, 86.71, 86.71, 86.71]),
    expectedStrength: 0,
  },
  {
    name: "short current close equals lowest reference",
    side: "short",
    closes: [88, 87.5, 87, 86.9, 86.71],
    candleTs: buildCandleTs([88, 87.5, 87, 86.9, 86.71]),
    expectedStrength: 0,
  },
  {
    name: "long current close equals highest reference",
    side: "long",
    closes: [84, 85, 86, 86.5, 86.71],
    candleTs: buildCandleTs([84, 85, 86, 86.5, 86.71]),
    expectedStrength: 0,
  },
];

const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

let failed = 0;

for (const testCase of cases) {
  const result = computeStrengthPct(testCase.side, testCase.closes, testCase.candleTs, LOOKBACK);
  const actual = result.strengthPct ?? -1;
  const pass = approx(actual, testCase.expectedStrength);
  console.log(pass ? "[PASS]" : "[FAIL]", testCase.name, {
    expected: testCase.expectedStrength,
    actual,
    debug: result.debug,
  });
  if (!pass) failed += 1;
}

// User-reported short crossover scenario: close at lookback low -> strength 0
const userCloses = [87.2, 86.95, 86.8, 86.75, 86.71];
const userCase = computeStrengthPct("short", userCloses, buildCandleTs(userCloses), LOOKBACK);
console.log("[INFO] user-like short at low", {
  strengthPct: userCase.strengthPct,
  selectedReferenceClose: userCase.debug?.selectedReferenceClose,
  selectedReferenceCandleTs: userCase.debug?.selectedReferenceCandleTs,
  lookbackCloses: userCase.debug?.lookbackCloses,
  lookbackCandleTs: userCase.debug?.lookbackCandleTs,
});

if (failed > 0) {
  console.error(`[O1_STRENGTH_CALC_TEST] ${failed} case(s) failed`);
  process.exit(1);
}

console.log("[O1_STRENGTH_CALC_TEST] all cases passed");
