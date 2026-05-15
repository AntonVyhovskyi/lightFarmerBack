import { logDebug } from "./logger";

type Uint8ArrayWithToHex = Uint8Array & { toHex?: () => string };

export const hasUint8ArrayToHex = (): boolean => {
  return typeof (Uint8Array.prototype as Uint8ArrayWithToHex).toHex === "function";
};

export const applyO1Uint8ArrayToHexPolyfill = (): void => {
  if (hasUint8ArrayToHex()) return;

  (Uint8Array.prototype as Uint8ArrayWithToHex).toHex = function toHex(this: Uint8Array): string {
    return Buffer.from(this).toString("hex");
  };

  logDebug("O1_SESSION", "Applied Uint8Array.toHex polyfill");
};
