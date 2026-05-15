import { Connection } from "@solana/web3.js";
import { Nord, NordUser } from "@n1xyz/nord-ts";
import { readO1Env, validateO1Env } from "./env";
import { applyO1Uint8ArrayToHexPolyfill } from "./hexPolyfill";
import { logInfo } from "./logger";
import { resetSyncLogger } from "./syncLogger";
import type { O1EnvConfig } from "./types";

let nordClient: Nord | null = null;
let nordUser: NordUser | null = null;
let envCache: O1EnvConfig | null = null;

export const getO1Config = (): O1EnvConfig => {
  if (!envCache) envCache = readO1Env();
  return envCache;
};

export const resetO1Client = (): void => {
  nordClient = null;
  nordUser = null;
  envCache = null;
  resetSyncLogger();
};

export const initO1Client = async (): Promise<{ config: O1EnvConfig; nord: Nord; user: NordUser }> => {
  applyO1Uint8ArrayToHexPolyfill();
  const config = getO1Config();
  const missing = validateO1Env(config);
  if (missing.length > 0) {
    throw new Error(`Missing or invalid O1 env vars: ${missing.join(", ")}`);
  }

  logInfo("O1_START", "Initializing O1 bot", {
    symbol: config.symbol,
    resolution: config.resolution,
    strategy: config.strategyName,
    dryRun: config.dryRun,
    marketId: config.marketId,
    accountId: config.accountId,
  });

  if (!nordClient) {
    nordClient = await Nord.new({
      app: config.appKey,
      webServerUrl: config.webServerUrl,
      solanaConnection: new Connection(config.solanaRpcUrl),
      protonUrl: config.webServerUrl,
    });
  }

  if (!nordUser) {
    nordUser = NordUser.fromPrivateKey(nordClient, config.privateKey);
    await nordUser.updateAccountId();
    await nordUser.fetchInfo();
  }

  if (!config.accountId) {
    const accountId = nordUser.accountIds?.[0];
    if (!accountId) throw new Error("Unable to resolve accountId from NordUser.");
    config.accountId = accountId;
  }

  return { config, nord: nordClient, user: nordUser };
};

export const getInitializedO1Client = (): { config: O1EnvConfig; nord: Nord; user: NordUser } => {
  if (!nordClient || !nordUser) {
    throw new Error("O1 client is not initialized.");
  }
  return { config: getO1Config(), nord: nordClient, user: nordUser };
};
