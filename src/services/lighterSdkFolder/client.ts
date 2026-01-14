import { SignerClient, OrderType } from 'lighter-ts-sdk';
import dotenv from 'dotenv';

dotenv.config();

let signerClient: SignerClient | null = null;

export async function getSigner(): Promise<SignerClient> {
    if (signerClient) return signerClient;
    signerClient = new SignerClient({
        url: process.env.BASE_URL!,
        privateKey: process.env.API_PRIVATE_KEY!,
        accountIndex: parseInt(process.env.ACCOUNT_INDEX!),
        apiKeyIndex: parseInt(process.env.API_KEY_INDEX!)
    });

    await signerClient.initialize();
    await signerClient.ensureWasmClient();

    return signerClient;
}
