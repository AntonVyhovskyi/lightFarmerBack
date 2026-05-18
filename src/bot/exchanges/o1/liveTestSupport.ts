import type { Nord, NordUser } from "@n1xyz/nord-ts";
import { Side, TriggerKind } from "@n1xyz/nord-ts";
import type { O1EnvConfig, O1Order, O1Result, O1State, O1TriggerSpec } from "./types";

export type O1LiveTestEnv = {
  allowLiveTest: boolean;
  dryRun: boolean;
  mainnetConfirmed: boolean;
  maxNotional: number;
  autoCloseOnError: boolean;
};

export const readO1LiveTestEnv = (): O1LiveTestEnv => ({
  allowLiveTest: process.env.O1_ALLOW_LIVE_TEST === "true",
  dryRun: process.env.O1_DRY_RUN === "true",
  mainnetConfirmed: process.env.O1_TEST_MAINNET_CONFIRMED === "true",
  maxNotional: Number(process.env.O1_TEST_MAX_NOTIONAL ?? "12"),
  autoCloseOnError: process.env.O1_TEST_AUTO_CLOSE_ON_ERROR === "true",
});

export const isMainnetO1Env = (config: O1EnvConfig): boolean => {
  const web = config.webServerUrl.toLowerCase();
  const rpc = config.solanaRpcUrl.toLowerCase();
  return web.includes("zo-mainnet.n1.xyz") && rpc.includes("mainnet");
};

export const syncO1StateFromUser = (
  state: O1State,
  user: NordUser,
  accountId: number,
  marketId: number
): void => {
  const key = String(accountId);
  const positions = user.positions[key] ?? [];
  const target = positions.find((position) => position.marketId === marketId);
  const base = target?.perp?.baseSize ?? 0;
  const signed = target?.perp?.isLong ? base : -base;
  state.positionSize = Number.isFinite(signed) ? signed : 0;
  state.entryPrice = Number(target?.perp?.price ?? 0);
  state.orders = (user.orders[key] ?? [])
    .filter((order) => order.marketId === marketId)
    .map((order): O1Order => ({
      orderId: order.orderId,
      marketId: order.marketId,
      side: order.side,
      size: order.size,
      price: order.price,
      originalOrderSize: order.originalOrderSize,
      clientOrderId: order.clientOrderId,
    }));

  const balances = user.balances[key] ?? [];
  const total = balances.reduce((sum, item) => sum + Number(item.balance), 0);
  state.balanceTotal = total;
  state.balanceAvailable = total;
  state.lastSyncAt = Date.now();
};

export const seedExecutorStateForLiveTest = (state: O1State, lastPrice: number): void => {
  const now = Date.now();
  const candle = [
    String(now),
    String(lastPrice),
    String(lastPrice),
    String(lastPrice),
    String(lastPrice),
    "0",
    String(now),
    "0",
    "0",
    "0",
    "0",
    "0",
  ] as O1State["candles"][number];

  state.candles = Array.from({ length: 120 }, () => candle);
  state.lastPrice = lastPrice;
  state.ws.lastCandleUpdateAt = now;
  state.ws.lastAccountUpdateAt = now;
};

export const fetchActiveTriggers = async (nord: Nord, accountId: number) => {
  return nord.getAccountTriggers({ accountId });
};

export const roundToDecimals = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
};

const unscaleMantissa = (value: number, decimals: number): number => {
  return value / 10 ** decimals;
};

export type ApiAccountTrigger = Awaited<ReturnType<typeof fetchActiveTriggers>>[number];

type NormalizedAccountTrigger = {
  marketId: number;
  triggerId: bigint;
  side: "ask" | "bid";
  kind: "stopLoss" | "takeProfit";
  triggerPriceMantissa: number;
  limitPriceMantissa: number | null;
  limitBaseSizeMantissa: number | null;
};

export const normalizeAccountTrigger = (row: ApiAccountTrigger): NormalizedAccountTrigger => {
  const nested = (row as { trigger?: Record<string, unknown> }).trigger;
  if (nested && typeof nested === "object") {
    const limits = nested.limits as Record<string, unknown> | undefined;
    const sideRaw = String(nested.side ?? "bid");
    const kindRaw = String(nested.kind ?? "stopLoss");
    return {
      marketId: row.marketId,
      triggerId: BigInt(row.triggerId),
      side: sideRaw === "ask" ? "ask" : "bid",
      kind: kindRaw === "takeProfit" ? "takeProfit" : "stopLoss",
      triggerPriceMantissa: Number(nested.trigger_price ?? nested.triggerPrice ?? 0),
      limitPriceMantissa: limits?.price != null ? Number(limits.price) : null,
      limitBaseSizeMantissa: limits?.base_size != null ? Number(limits.base_size) : null,
    };
  }

  const flat = row as {
    side?: string;
    kind?: string;
    triggerPrice?: number;
    limitPrice?: number | null;
    limitBaseSize?: number | null;
  };
  return {
    marketId: row.marketId,
    triggerId: BigInt(row.triggerId),
    side: flat.side === "ask" ? "ask" : "bid",
    kind: flat.kind === "takeProfit" ? "takeProfit" : "stopLoss",
    triggerPriceMantissa: Number(flat.triggerPrice ?? 0),
    limitPriceMantissa: flat.limitPrice != null ? Number(flat.limitPrice) : null,
    limitBaseSizeMantissa: flat.limitBaseSize != null ? Number(flat.limitBaseSize) : null,
  };
};

export const toTriggerSpecFromApi = (
  trigger: ApiAccountTrigger,
  priceDecimals: number,
  sizeDecimals: number
): O1TriggerSpec => {
  const normalized = normalizeAccountTrigger(trigger);
  return {
    marketId: normalized.marketId,
    side: normalized.side === "ask" ? Side.Ask : Side.Bid,
    kind: normalized.kind === "takeProfit" ? TriggerKind.TakeProfit : TriggerKind.StopLoss,
    triggerId: normalized.triggerId,
    triggerPrice: unscaleMantissa(normalized.triggerPriceMantissa, priceDecimals),
    limitPrice:
      normalized.limitPriceMantissa != null
        ? unscaleMantissa(normalized.limitPriceMantissa, priceDecimals)
        : undefined,
    limitBaseSize:
      normalized.limitBaseSizeMantissa != null
        ? unscaleMantissa(normalized.limitBaseSizeMantissa, sizeDecimals)
        : undefined,
  };
};

export type O1TriggerSummary = {
  marketId: number;
  triggerId: number;
  side: string;
  kind: string;
  status: string;
  triggerPriceMantissa: number;
  limitPriceMantissa: number | null;
  limitBaseSizeMantissa: number | null;
  limitQuoteSizeMantissa: number | null;
  triggerPrice: number;
  limitPrice?: number;
  limitBaseSize?: number;
};

export const summarizeTrigger = (
  trigger: ApiAccountTrigger,
  priceDecimals: number,
  sizeDecimals: number
): O1TriggerSummary => {
  const normalized = normalizeAccountTrigger(trigger);
  const spec = toTriggerSpecFromApi(trigger, priceDecimals, sizeDecimals);
  return {
    marketId: normalized.marketId,
    triggerId: Number(normalized.triggerId),
    side: normalized.side,
    kind: normalized.kind,
    status: (trigger as { status?: string }).status ?? "active",
    triggerPriceMantissa: normalized.triggerPriceMantissa,
    limitPriceMantissa: normalized.limitPriceMantissa,
    limitBaseSizeMantissa: normalized.limitBaseSizeMantissa,
    limitQuoteSizeMantissa: null,
    triggerPrice: spec.triggerPrice,
    limitPrice: spec.limitPrice,
    limitBaseSize: spec.limitBaseSize,
  };
};

export const filterMarketTriggersByKind = (
  triggers: ApiAccountTrigger[],
  marketId: number,
  kind: "stopLoss" | "takeProfit"
): ApiAccountTrigger[] => {
  return triggers.filter((row) => {
    if (row.marketId !== marketId) return false;
    return normalizeAccountTrigger(row).kind === kind;
  });
};

export const triggersMatchSpec = (
  trigger: Awaited<ReturnType<typeof fetchActiveTriggers>>[number],
  spec: O1TriggerSpec,
  priceDecimals: number,
  sizeDecimals: number
): boolean => {
  const normalized = toTriggerSpecFromApi(trigger, priceDecimals, sizeDecimals);
  if (spec.triggerId !== undefined && normalized.triggerId !== undefined) {
    return normalized.triggerId === spec.triggerId;
  }
  return (
    normalized.marketId === spec.marketId &&
    normalized.side === spec.side &&
    normalized.kind === spec.kind &&
    normalized.triggerPrice === spec.triggerPrice &&
    (spec.limitPrice === undefined || (normalized.limitPrice ?? undefined) === spec.limitPrice) &&
    (spec.limitBaseSize === undefined ||
      (normalized.limitBaseSize ?? undefined) === spec.limitBaseSize) &&
    (spec.limitQuoteSize === undefined ||
      (normalized.limitQuoteSize ?? undefined) === spec.limitQuoteSize)
  );
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const verifyExchangeStopLoss = async (args: {
  nord: Nord;
  accountId: number;
  marketId: number;
  expectedSpec?: O1TriggerSpec;
  priceDecimals?: number;
  sizeDecimals?: number;
  attempts?: number;
  delayMs?: number;
}): Promise<{ ok: boolean; slCount: number; triggerIds: string[]; matchedTriggerId?: string }> => {
  const {
    nord,
    accountId,
    marketId,
    expectedSpec,
    priceDecimals = 2,
    sizeDecimals = 4,
    attempts = 5,
    delayMs = 1500,
  } = args;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(delayMs);
    const triggers = await fetchActiveTriggers(nord, accountId);
    const slTriggers = filterMarketTriggersByKind(triggers, marketId, "stopLoss");
    if (slTriggers.length === 0) continue;

    const triggerIds = slTriggers.map((t) => String(t.triggerId));
    if (!expectedSpec) {
      return { ok: true, slCount: slTriggers.length, triggerIds };
    }

    const matched = slTriggers.find((row) =>
      triggersMatchSpec(row, expectedSpec, priceDecimals, sizeDecimals)
    );
    if (matched) {
      return {
        ok: true,
        slCount: slTriggers.length,
        triggerIds,
        matchedTriggerId: String(matched.triggerId),
      };
    }

    const newest = slTriggers.reduce((latest, row) =>
      Number(row.triggerId) > Number(latest.triggerId) ? row : latest
    );
    return {
      ok: true,
      slCount: slTriggers.length,
      triggerIds,
      matchedTriggerId: String(newest.triggerId),
    };
  }
  return { ok: false, slCount: 0, triggerIds: [] };
};

export const waitForRecordedTriggers = async ({
  nord,
  accountId,
  marketId,
  specs,
  priceDecimals,
  sizeDecimals,
  attempts = 8,
  delayMs = 500,
}: {
  nord: Nord;
  accountId: number;
  marketId: number;
  specs: O1TriggerSpec[];
  priceDecimals: number;
  sizeDecimals: number;
  attempts?: number;
  delayMs?: number;
}): Promise<{
  ok: boolean;
  attempt: number;
  marketTriggers: Awaited<ReturnType<typeof fetchActiveTriggers>>;
  summaries: O1TriggerSummary[];
  missingSpecs: O1TriggerSpec[];
}> => {
  let lastMarketTriggers: Awaited<ReturnType<typeof fetchActiveTriggers>> = [];
  let lastSummaries: O1TriggerSummary[] = [];
  let missingSpecs = specs;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const triggers = await fetchActiveTriggers(nord, accountId);
    lastMarketTriggers = triggers.filter((trigger) => trigger.marketId === marketId);
    lastSummaries = lastMarketTriggers.map((trigger) => summarizeTrigger(trigger, priceDecimals, sizeDecimals));
    missingSpecs = specs.filter(
      (spec) => !lastMarketTriggers.some((trigger) => triggersMatchSpec(trigger, spec, priceDecimals, sizeDecimals))
    );

    if (missingSpecs.length === 0) {
      return {
        ok: true,
        attempt,
        marketTriggers: lastMarketTriggers,
        summaries: lastSummaries,
        missingSpecs: [],
      };
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return {
    ok: false,
    attempt: attempts,
    marketTriggers: lastMarketTriggers,
    summaries: lastSummaries,
    missingSpecs,
  };
};

export const waitForAccountFlat = async ({
  nord,
  executor,
  state,
  user,
  accountId,
  marketId,
  priceDecimals,
  sizeDecimals,
  requireTriggersZero = true,
  attempts = 10,
  delayMs = 500,
}: {
  nord: Nord;
  executor: { syncAccount: () => Promise<O1Result> };
  state: O1State;
  user: NordUser;
  accountId: number;
  marketId: number;
  priceDecimals: number;
  sizeDecimals: number;
  requireTriggersZero?: boolean;
  attempts?: number;
  delayMs?: number;
}): Promise<{
  ok: boolean;
  attempt: number;
  positionSize: number;
  openOrders: number;
  activeTriggers: number;
  triggerSummaries: O1TriggerSummary[];
}> => {
  let positionSize = 0;
  let openOrders = 0;
  let activeTriggers = 0;
  let triggerSummaries: O1TriggerSummary[] = [];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await executor.syncAccount();
    syncO1StateFromUser(state, user, accountId, marketId);
    const triggers = await fetchActiveTriggers(nord, accountId);
    const marketTriggers = triggers.filter((trigger) => trigger.marketId === marketId);
    triggerSummaries = marketTriggers.map((trigger) => summarizeTrigger(trigger, priceDecimals, sizeDecimals));
    positionSize = state.positionSize;
    openOrders = state.orders.length;
    activeTriggers = marketTriggers.length;

    if (positionSize === 0 && openOrders === 0 && (!requireTriggersZero || activeTriggers === 0)) {
      return { ok: true, attempt, positionSize, openOrders, activeTriggers, triggerSummaries };
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return { ok: false, attempt: attempts, positionSize, openOrders, activeTriggers, triggerSummaries };
};
