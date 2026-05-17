import { FillMode, Side, TriggerKind, type NordUser } from "@n1xyz/nord-ts";
import { logNormalizedFailure, normalizeO1Error } from "./errors";
import {
  compactOrderRequest,
  compactTriggerSpec,
  logDebug,
  logError,
  logInfo,
} from "./logger";
import { roundToDecimals, sleep } from "./liveTestSupport";
import { ensureO1TradingSession, refreshO1TradingSession } from "./session";
import { validateClosePosition, validatePreTrade, validateSafetyGuardrails } from "./validators";
import type { O1EnvConfig, O1Order, O1PlaceOrderRequest, O1Result, O1State, O1TriggerSpec } from "./types";

export class O1Executor {
  private readonly sentTriggerSpecs: O1TriggerSpec[] = [];

  constructor(
    private readonly user: NordUser,
    private readonly config: O1EnvConfig,
    private readonly state: O1State
  ) {}

  private async ensureLiveSession(): Promise<O1Result | undefined> {
    const session = await ensureO1TradingSession(this.user, this.config.dryRun);
    if (!session.ok) return session;
    return undefined;
  }

  private async place(req: O1PlaceOrderRequest): Promise<O1Result<{ actionId?: string; orderId?: string }>> {
    const compact = compactOrderRequest(req);
    logDebug("O1_ORDER", "Validating order", compact);

    const safety = validateSafetyGuardrails(this.config, this.state);
    if (!safety.ok) return safety;
    const validation = validatePreTrade(this.config, this.state, req);
    if (!validation.ok) return validation;

    if (this.config.dryRun) {
      logInfo("O1_ORDER", "Dry-run blocked live order", compact);
      return { ok: true, data: { actionId: "dry-run", orderId: "dry-run" } };
    }

    const sessionError = await this.ensureLiveSession();
    if (sessionError) return sessionError;

    try {
      if (req.clientOrderId) this.state.pendingClientOrderIds.add(req.clientOrderId);
      logInfo("O1_ORDER", "Submitting order", compact);
      const result = await this.user.placeOrder({
        marketId: req.marketId,
        side: req.side,
        fillMode: req.fillMode,
        isReduceOnly: req.isReduceOnly,
        size: req.size,
        price: req.price,
        quoteSize: req.quoteSize,
        accountId: this.config.accountId,
        clientOrderId: req.clientOrderId,
      });
      this.state.lastOrderAt = Date.now();
      if (req.clientOrderId) this.state.pendingClientOrderIds.delete(req.clientOrderId);
      logInfo("O1_ORDER", "Order submitted", {
        ...compact,
        actionId: result.actionId.toString(),
        orderId: result.orderId?.toString(),
      });
      return { ok: true, data: { actionId: result.actionId.toString(), orderId: result.orderId?.toString() } };
    } catch (err) {
      if (req.clientOrderId) this.state.pendingClientOrderIds.delete(req.clientOrderId);
      const normalized = normalizeO1Error(err);
      logNormalizedFailure("O1_ORDER", "Order placement failed", normalized);
      return normalized;
    }
  }

  async openLong(size: number, price?: number): Promise<O1Result> {
    return this.place({
      marketId: this.config.marketId,
      side: Side.Bid,
      fillMode: price ? FillMode.Limit : FillMode.ImmediateOrCancel,
      isReduceOnly: false,
      size,
      price,
      clientOrderId: Date.now(),
    });
  }

  async openShort(size: number, price?: number): Promise<O1Result> {
    return this.place({
      marketId: this.config.marketId,
      side: Side.Ask,
      fillMode: price ? FillMode.Limit : FillMode.ImmediateOrCancel,
      isReduceOnly: false,
      size,
      price,
      clientOrderId: Date.now(),
    });
  }

  async closePosition(): Promise<O1Result> {
    if (this.state.positionSize === 0) return { ok: true };
    const side = this.state.positionSize > 0 ? Side.Ask : Side.Bid;
    const req: O1PlaceOrderRequest = {
      marketId: this.config.marketId,
      side,
      fillMode: FillMode.ImmediateOrCancel,
      isReduceOnly: true,
      size: Math.abs(this.state.positionSize),
      clientOrderId: Date.now(),
    };

    const compact = compactOrderRequest(req);
    const validation = validateClosePosition(this.config, this.state, req);
    if (validation.ok === false) {
      logError("O1_CLOSE", "Position close validation failed", {
        reason: validation.reason,
        ...compact,
      });
      return validation;
    }

    if (this.config.dryRun) {
      logInfo("O1_CLOSE", "Dry-run blocked live close", compact);
      return { ok: true };
    }

    const sessionError = await this.ensureLiveSession();
    if (sessionError !== undefined) {
      if (sessionError.ok === false) {
        logNormalizedFailure("O1_CLOSE", "Position close session preparation failed", sessionError);
      }
      return sessionError;
    }

    try {
      logInfo("O1_CLOSE", "Submitting reduce-only close", compact);
      const result = await this.user.placeOrder({
        marketId: req.marketId,
        side: req.side,
        fillMode: req.fillMode,
        isReduceOnly: true,
        size: req.size,
        accountId: this.config.accountId,
        clientOrderId: req.clientOrderId,
      });
      this.state.lastOrderAt = Date.now();
      logInfo("O1_CLOSE", "Position close submitted", {
        ...compact,
        actionId: result.actionId.toString(),
        orderId: result.orderId?.toString(),
      });
      return { ok: true, data: { actionId: result.actionId.toString(), orderId: result.orderId?.toString() } };
    } catch (err) {
      const normalized = normalizeO1Error(err);
      logNormalizedFailure("O1_CLOSE", "Position close failed", normalized);
      return normalized;
    }
  }

  async cancelOrder(orderId: number): Promise<O1Result> {
    if (this.config.dryRun) return { ok: true };
    const sessionError = await this.ensureLiveSession();
    if (sessionError) return sessionError;
    try {
      await this.user.cancelOrder(orderId, this.config.accountId);
      logDebug("O1_ORDER", "Order cancelled", { orderId });
      return { ok: true };
    } catch (err) {
      return normalizeO1Error(err);
    }
  }

  async cancelOrderByClientId(clientOrderId: number): Promise<O1Result> {
    if (this.config.dryRun) return { ok: true };
    const sessionError = await this.ensureLiveSession();
    if (sessionError) return sessionError;
    try {
      await this.user.cancelOrderByClientId(clientOrderId, this.config.accountId);
      logDebug("O1_ORDER", "Order cancelled by client id", { clientOrderId });
      return { ok: true };
    } catch (err) {
      return normalizeO1Error(err);
    }
  }

  async cancelAllKnownOrders(): Promise<O1Result> {
    const cancellations = await Promise.all(this.state.orders.map((o) => this.cancelOrder(o.orderId)));
    const failed = cancellations.find((c) => !c.ok);
    return failed ?? { ok: true };
  }

  async atomic(actions: Parameters<NordUser["atomic"]>[0]): Promise<O1Result> {
    if (this.config.dryRun) return { ok: true };
    const sessionError = await this.ensureLiveSession();
    if (sessionError) return sessionError;
    try {
      await this.user.atomic(actions, this.config.accountId);
      return { ok: true };
    } catch (err) {
      return normalizeO1Error(err);
    }
  }

  async placeLimitOrder(side: Side, size: number, price: number, reduceOnly = false): Promise<O1Result> {
    return this.place({
      marketId: this.config.marketId,
      side,
      fillMode: FillMode.Limit,
      isReduceOnly: reduceOnly,
      size,
      price,
      clientOrderId: Date.now(),
    });
  }

  async placeMarketLikeOrder(side: Side, quoteSize: number, reduceOnly = false): Promise<O1Result> {
    return this.place({
      marketId: this.config.marketId,
      side,
      fillMode: FillMode.ImmediateOrCancel,
      isReduceOnly: reduceOnly,
      quoteSize,
      clientOrderId: Date.now(),
    });
  }

  async placeStopLoss(triggerPrice: number, side: Side, size?: number): Promise<O1Result<{ triggerId?: string }>> {
    return this.addTrigger({
      marketId: this.config.marketId,
      side,
      kind: TriggerKind.StopLoss,
      triggerPrice,
      limitPrice: triggerPrice,
      limitBaseSize: size,
    });
  }

  async placeInitialStopLoss(
    spec: O1TriggerSpec,
    priceDecimals: number,
    sizeDecimals: number,
    postEntryDelayMs = 1500
  ): Promise<O1Result<{ triggerId?: string }>> {
    const roundedSpec: O1TriggerSpec = {
      ...spec,
      triggerPrice: roundToDecimals(spec.triggerPrice, priceDecimals),
      limitPrice:
        spec.limitPrice !== undefined
          ? roundToDecimals(spec.limitPrice, priceDecimals)
          : roundToDecimals(spec.triggerPrice, priceDecimals),
      limitBaseSize:
        spec.limitBaseSize !== undefined
          ? roundToDecimals(spec.limitBaseSize, sizeDecimals)
          : undefined,
    };

    await sleep(postEntryDelayMs);
    let lastResult: O1Result<{ triggerId?: string }> = { ok: false, reason: "stop-loss-not-attempted" };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt);
      const session = await refreshO1TradingSession(this.user, this.config.dryRun);
      if (!session.ok) return session;
      lastResult = await this.addTrigger(roundedSpec);
      if (lastResult.ok) return lastResult;
      logError("O1_SL", "Stop-loss placement attempt failed", {
        attempt: attempt + 1,
        reason: lastResult.reason,
        triggerPrice: roundedSpec.triggerPrice,
      });
    }
    return lastResult;
  }

  async placeTakeProfit(triggerPrice: number, side: Side, size?: number): Promise<O1Result> {
    return this.addTrigger({
      marketId: this.config.marketId,
      side,
      kind: TriggerKind.TakeProfit,
      triggerPrice,
      limitBaseSize: size,
    });
  }

  async updateStopLoss(oldSpec: O1TriggerSpec, nextSpec: O1TriggerSpec): Promise<O1Result<{ triggerId?: string }>> {
    if (oldSpec.triggerId !== undefined) {
      return this.editTrigger(oldSpec.triggerId, nextSpec);
    }
    const remove = await this.removeTrigger(oldSpec);
    if (!remove.ok) return remove;
    return this.addTrigger(nextSpec);
  }

  async updateTakeProfit(oldSpec: O1TriggerSpec, nextSpec: O1TriggerSpec): Promise<O1Result<{ triggerId?: string }>> {
    if (oldSpec.triggerId !== undefined) {
      return this.editTrigger(oldSpec.triggerId, nextSpec);
    }
    const remove = await this.removeTrigger(oldSpec);
    if (!remove.ok) return remove;
    return this.addTrigger(nextSpec);
  }

  async removeKnownTrigger(spec: O1TriggerSpec): Promise<O1Result> {
    return this.removeTrigger(spec);
  }

  private rememberTrigger(spec: O1TriggerSpec): void {
    this.sentTriggerSpecs.push({ ...spec });
  }

  private forgetTrigger(spec: O1TriggerSpec): void {
    const index = this.sentTriggerSpecs.findIndex((entry) => this.triggerSpecsMatch(entry, spec));
    if (index >= 0) this.sentTriggerSpecs.splice(index, 1);
  }

  private triggerSpecsMatch(left: O1TriggerSpec, right: O1TriggerSpec): boolean {
    if (left.triggerId !== undefined && right.triggerId !== undefined) {
      return left.triggerId === right.triggerId;
    }
    return (
      left.marketId === right.marketId &&
      left.side === right.side &&
      left.kind === right.kind &&
      left.triggerPrice === right.triggerPrice &&
      left.limitPrice === right.limitPrice &&
      left.limitBaseSize === right.limitBaseSize &&
      left.limitQuoteSize === right.limitQuoteSize
    );
  }

  private async editTrigger(triggerId: bigint, spec: O1TriggerSpec): Promise<O1Result<{ triggerId?: string }>> {
    const compact = compactTriggerSpec({ ...spec, triggerId });
    const tag = spec.kind === TriggerKind.TakeProfit ? "O1_TP" : "O1_SL";
    if (this.config.dryRun) {
      logInfo(tag, "Dry-run blocked live trigger edit", compact);
      return { ok: true, data: { triggerId: triggerId.toString() } };
    }

    const sessionError = await this.ensureLiveSession();
    if (sessionError) return sessionError;

    try {
      logInfo(tag, "Editing trigger", compact);
      await this.user.editTrigger({
        triggerId,
        marketId: spec.marketId,
        side: spec.side,
        kind: spec.kind,
        triggerPrice: spec.triggerPrice,
        limitPrice: spec.limitPrice,
        limitBaseSize: spec.limitBaseSize,
        limitQuoteSize: spec.limitQuoteSize,
        accountId: this.config.accountId,
      });
      const stored = { ...spec, triggerId };
      const index = this.sentTriggerSpecs.findIndex((entry) => entry.triggerId === triggerId);
      if (index >= 0) this.sentTriggerSpecs[index] = stored;
      else this.rememberTrigger(stored);
      logInfo(tag, "Trigger edited", compact);
      return { ok: true, data: { triggerId: triggerId.toString() } };
    } catch (err) {
      const normalized = normalizeO1Error(err);
      logNormalizedFailure(tag, "Trigger edit failed", normalized);
      return normalized;
    }
  }

  private async addTrigger(spec: O1TriggerSpec): Promise<O1Result<{ triggerId?: string }>> {
    const compact = compactTriggerSpec(spec);
    const tag = spec.kind === TriggerKind.TakeProfit ? "O1_TP" : "O1_SL";
    if (this.config.dryRun) {
      logInfo(tag, "Dry-run blocked live trigger", compact);
      return { ok: true };
    }

    const sessionError = await this.ensureLiveSession();
    if (sessionError) return sessionError;

    try {
      logInfo(tag, "Submitting trigger", compact);
      const result = await this.user.addTrigger({ ...spec, accountId: this.config.accountId });
      const stored = { ...spec, triggerId: result.triggerId };
      this.rememberTrigger(stored);
      logInfo(tag, "Trigger submitted", { ...compact, triggerId: result.triggerId.toString() });
      return { ok: true, data: { triggerId: result.triggerId.toString() } };
    } catch (err) {
      const normalized = normalizeO1Error(err);
      logNormalizedFailure(tag, "Trigger submission failed", normalized);
      return normalized;
    }
  }

  private async removeTrigger(spec: O1TriggerSpec): Promise<O1Result> {
    const compact = compactTriggerSpec(spec);
    const tag = spec.kind === TriggerKind.TakeProfit ? "O1_TP" : "O1_SL";
    if (this.config.dryRun) {
      logInfo(tag, "Dry-run blocked live trigger removal", compact);
      return { ok: true };
    }

    const sessionError = await this.ensureLiveSession();
    if (sessionError) return sessionError;

    if (spec.triggerId === undefined) {
      logError(tag, "Cannot remove trigger without triggerId", compact);
      return { ok: false, reason: "trigger_execution_failed" };
    }

    try {
      logInfo(tag, "Removing trigger", compact);
      await this.user.removeTrigger({
        marketId: spec.marketId,
        triggerId: spec.triggerId,
        accountId: this.config.accountId,
      });
      this.forgetTrigger(spec);
      logInfo(tag, "Trigger removed", compact);
      return { ok: true };
    } catch (err) {
      const normalized = normalizeO1Error(err);
      logNormalizedFailure(tag, "Trigger removal failed", normalized);
      return normalized;
    }
  }

  async syncAccount(): Promise<O1Result> {
    try {
      await this.user.fetchInfo();
      this.state.lastSyncAt = Date.now();
      return { ok: true };
    } catch (err) {
      const normalized = normalizeO1Error(err);
      logNormalizedFailure("O1_SYNC", "Account sync failed", normalized);
      return normalized;
    }
  }

  getPosition(): number {
    return this.state.positionSize;
  }

  getBalance(): { total: number; available: number } {
    return { total: this.state.balanceTotal, available: this.state.balanceAvailable };
  }

  getOpenOrders(): O1Order[] {
    return this.state.orders;
  }

  getRecordedTriggerSpecs(): O1TriggerSpec[] {
    return this.sentTriggerSpecs.map((spec) => ({ ...spec }));
  }
}
