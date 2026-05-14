import dotenv from "dotenv";
import { Connection } from "@solana/web3.js";
import { Nord } from "@n1xyz/nord-ts";

dotenv.config();

const readRequiredEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env: ${key}`);
  }
  return value;
};

async function main() {
  const app = readRequiredEnv("O1_APP_KEY");
  const webServerUrl = readRequiredEnv("O1_WEB_SERVER_URL");
  const solanaRpcUrl = readRequiredEnv("O1_SOLANA_RPC_URL");

  console.log("[O1_MARKETS] Initializing Nord client...");
  const nord = await Nord.new({
    app,
    webServerUrl,
    solanaConnection: new Connection(solanaRpcUrl),
    protonUrl: webServerUrl,
  });

  console.log("[O1_MARKETS] Fetching markets...");
  const info = await nord.getInfo();

  const rows = (info.markets ?? []).map((market) => {
    const extra = market as unknown as Record<string, unknown>;
    const name = typeof extra.name === "string" ? extra.name : "";

    return {
      marketId: market.marketId,
      symbol: market.symbol,
      name,
    };
  });

  if (rows.length === 0) {
    console.log("[O1_MARKETS] No markets returned.");
    return;
  }

  console.table(rows);
}

main().catch((error: unknown) => {
  console.error("[O1_MARKETS] Failed:", error);
  process.exit(1);
});
