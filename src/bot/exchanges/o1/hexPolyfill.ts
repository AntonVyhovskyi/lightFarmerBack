import { o1Log } from "./logger";

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));

const bytesToHexLower = (bytes: Uint8Array): string => {
  let hex = "";
  for (let index = 0; index < bytes.length; index++) {
    hex += HEX[bytes[index]!]!;
  }
  return hex;
};

export const hasUint8ArrayToHex = (): boolean => {
  return typeof (Uint8Array.prototype as Uint8Array & { toHex?: () => string }).toHex === "function";
};

export const applyO1Uint8ArrayToHexPolyfill = (): void => {
  if (hasUint8ArrayToHex()) return;

  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value: function toHex(this: Uint8Array) {
      return bytesToHexLower(this);
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });

  o1Log("O1_HEX_POLYFILL", "Applied Uint8Array.toHex polyfill");
};
