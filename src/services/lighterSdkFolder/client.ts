import { SignerClient } from 'lighter-ts-sdk';

let signerPromise: Promise<SignerClient> | null = null;

export function resetSigner() {
  signerPromise = null;
}

export function getSigner(): Promise<SignerClient> {
  if (signerPromise) return signerPromise;

  signerPromise = (async () => {
    const url = process.env.BASE_URL;
    const privateKey = process.env.API_PRIVATE_KEY;
    const accountIndex = Number(process.env.ACCOUNT_INDEX);
    const apiKeyIndex = Number(process.env.API_KEY_INDEX);

    if (!url || !privateKey || !Number.isFinite(accountIndex) || !Number.isFinite(apiKeyIndex)) {
      throw new Error('Missing/invalid env for signer');
    }

    const sc = new SignerClient({ url, privateKey, accountIndex, apiKeyIndex });

    await sc.initialize();
    await sc.ensureWasmClient();

    return sc;
  })().catch((err) => {
    signerPromise = null; // щоб наступна спроба могла повторити ініціалізацію
    throw err;
  });

  return signerPromise;
}