import dotenv from "dotenv";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { initO1Client, resetO1Client } from "../bot/exchanges/o1/client";
import { readO1Env } from "../bot/exchanges/o1/env";
import { applyO1Uint8ArrayToHexPolyfill, hasUint8ArrayToHex } from "../bot/exchanges/o1/hexPolyfill";

dotenv.config();

type PrivateKeyShape =
  | "empty"
  | "json-array"
  | "hex-0x"
  | "hex-no-prefix"
  | "base58-string"
  | "other-string"
  | "uint8array"
  | "unknown";

const classifyPrivateKeyInput = (value: unknown): PrivateKeyShape => {
  if (value === undefined || value === null || value === "") return "empty";
  if (value instanceof Uint8Array) return "uint8array";
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) return "json-array";
  if (trimmed.startsWith("0x")) return "hex-0x";
  if (/^[0-9a-fA-F]+$/.test(trimmed)) return "hex-no-prefix";
  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) return "base58-string";
  return "other-string";
};

const parsePrivateKeyBytes = (value: string): Uint8Array | null => {
  const shape = classifyPrivateKeyInput(value);
  try {
    if (shape === "json-array") {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return null;
      return Uint8Array.from(parsed.map((entry) => Number(entry)));
    }
    if (shape === "hex-0x" || shape === "hex-no-prefix") {
      const hex = value.startsWith("0x") ? value.slice(2) : value;
      return Uint8Array.from(Buffer.from(hex, "hex"));
    }
    if (shape === "base58-string") {
      return bs58.decode(value);
    }
  } catch {
    return null;
  }
  return null;
};

const describeSigner = (fn: unknown): Record<string, unknown> => ({
  typeof: typeof fn,
  name: typeof fn === "function" ? fn.name || "(anonymous)" : undefined,
});

const describeSessionId = (sessionId: bigint | undefined): Record<string, unknown> => ({
  present: sessionId !== undefined,
  isZero: sessionId === BigInt(0),
});

const describeUint8ArrayHexSupport = (): Record<string, unknown> => {
  const sample = Uint8Array.from([1, 2, 3]);
  return {
    nodeVersion: process.version,
    uint8ArrayToHexType: typeof (sample as Uint8Array & { toHex?: () => string }).toHex,
    uint8ArrayFromHexType: typeof (Uint8Array as typeof Uint8Array & { fromHex?: (hex: string) => Uint8Array }).fromHex,
    sampleConstructor: sample.constructor.name,
    sampleHasOwnToHex: Object.prototype.hasOwnProperty.call(sample, "toHex"),
  };
};

const describePayloadSigningExpectation = (): Record<string, unknown> => ({
  sdkSignHexEncodedPayloadExpects: "object with toHex() method (encoded action bytes)",
  prepareActionPasses: "Uint8Array from sizeDelimitedEncode(ActionSchema, action)",
  refreshSessionDefaultFraming: "hex unless NordUser.__use_solana_transaction_framing__ is true",
  solanaFramingUses: "Buffer.from(payload) in signSolanaTransactionFramedPayload",
});

async function main() {
  const env = readO1Env();
  const keyShape = classifyPrivateKeyInput(env.privateKey);
  const parsedKeyBytes = typeof env.privateKey === "string" ? parsePrivateKeyBytes(env.privateKey) : null;

  let derivedWalletPubkey: string | undefined;
  let derivedKeyLength: number | undefined;
  if (parsedKeyBytes) {
    try {
      const keypair = Keypair.fromSecretKey(parsedKeyBytes);
      derivedWalletPubkey = keypair.publicKey.toBase58();
      derivedKeyLength = parsedKeyBytes.length;
    } catch {
      derivedWalletPubkey = undefined;
    }
  }

  console.log("[O1_SESSION_DEBUG] private-key-shape", {
    typeofInput: typeof env.privateKey,
    shape: keyShape,
    inputLength: typeof env.privateKey === "string" ? env.privateKey.length : undefined,
    parsedKeyIsUint8Array: parsedKeyBytes instanceof Uint8Array,
    parsedKeyLength: derivedKeyLength,
    derivedWalletPubkey,
  });

  console.log("[O1_SESSION_DEBUG] runtime-hex-support", describeUint8ArrayHexSupport());
  console.log("[O1_SESSION_DEBUG] sdk-signing-contract", describePayloadSigningExpectation());

  resetO1Client();
  const { user } = await initO1Client();

  const userRecord = user as unknown as Record<string, unknown>;
  console.log("[O1_SESSION_DEBUG] user-before-refresh", {
    walletPubkey: user.publicKey.toBase58(),
    walletMatchesDerivedKey:
      derivedWalletPubkey === undefined ? undefined : derivedWalletPubkey === user.publicKey.toBase58(),
    session: describeSessionId(user.sessionId),
    signMessage: describeSigner(user.signMessage),
    signTransaction: describeSigner(user.signTransaction),
    signSessionMessage: describeSigner(user.signSessionMessage),
    useSolanaTransactionFraming: userRecord.__use_solana_transaction_framing__,
  });

  try {
    applyO1Uint8ArrayToHexPolyfill();
    console.log("[O1_SESSION_DEBUG] hex-before-refresh", {
      present: hasUint8ArrayToHex(),
    });
    await user.refreshSession();
    console.log("[O1_SESSION_DEBUG] refresh-success", {
      session: describeSessionId(user.sessionId),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("[O1_SESSION_DEBUG] refresh-error", {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause:
        err.cause instanceof Error
          ? { name: err.cause.name, message: err.cause.message, stack: err.cause.stack }
          : err.cause,
    });
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error("[O1_SESSION_DEBUG] fatal", {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
