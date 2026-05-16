import type { CandleResolution } from "@n1xyz/nord-ts";
import { logInfo } from "./logger";
import type { O1EnvConfig } from "./types";

export const O1_DIRECT_RESOLUTIONS = ["1", "5", "15"] as const;
export const O1_AGGREGATED_TARGET_RESOLUTION = "3";
export const O1_SUPPORTED_RESOLUTIONS = [...O1_DIRECT_RESOLUTIONS, O1_AGGREGATED_TARGET_RESOLUTION] as const;

export type O1SupportedResolution = (typeof O1_SUPPORTED_RESOLUTIONS)[number];
export type O1CandleMode = "direct" | "aggregated";

export type O1CandleHandling = {
  mode: O1CandleMode;
  configuredResolution: string;
  effectiveResolution: string;
  streamResolution: CandleResolution;
  aggregateFromResolution: CandleResolution | null;
};

const isDirectResolution = (resolution: string): resolution is (typeof O1_DIRECT_RESOLUTIONS)[number] => {
  return (O1_DIRECT_RESOLUTIONS as readonly string[]).includes(resolution);
};

export const resolveO1CandleHandling = (config: Pick<O1EnvConfig, "resolution">): O1CandleHandling => {
  const configuredResolution = String(config.resolution);

  if (configuredResolution === O1_AGGREGATED_TARGET_RESOLUTION) {
    return {
      mode: "aggregated",
      configuredResolution,
      effectiveResolution: O1_AGGREGATED_TARGET_RESOLUTION,
      streamResolution: "1",
      aggregateFromResolution: "1",
    };
  }

  if (isDirectResolution(configuredResolution)) {
    return {
      mode: "direct",
      configuredResolution,
      effectiveResolution: configuredResolution,
      streamResolution: configuredResolution as CandleResolution,
      aggregateFromResolution: null,
    };
  }

  throw new Error(
    `Unsupported O1_RESOLUTION=${configuredResolution}. Supported values: ${O1_SUPPORTED_RESOLUTIONS.join(", ")}`
  );
};

export const usesAggregatedCandles = (handling: O1CandleHandling): boolean => {
  return handling.mode === "aggregated";
};

export const logO1CandleMode = (handling: O1CandleHandling): void => {
  if (handling.mode === "aggregated") {
    logInfo("O1_CANDLE_MODE", "Using 1m aggregation", {
      configuredResolution: handling.configuredResolution,
      effectiveResolution: handling.effectiveResolution,
      streamResolution: handling.streamResolution,
    });
    return;
  }

  logInfo("O1_CANDLE_MODE", "Using direct candles", {
    configuredResolution: handling.configuredResolution,
    effectiveResolution: handling.effectiveResolution,
    streamResolution: handling.streamResolution,
  });
};

/** @deprecated Use resolveO1CandleHandling */
export const usesAggregated3mCandles = (resolution: string | CandleResolution): boolean => {
  return String(resolution) === O1_AGGREGATED_TARGET_RESOLUTION;
};
