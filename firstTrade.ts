import { SignerClient, OrderType } from 'lighter-ts-sdk';
import dotenv from 'dotenv';

dotenv.config();

async function placeOrder() {
  // Initialize the client
  const signerClient = new SignerClient({
    url: process.env.BASE_URL!,
    privateKey: process.env.API_PRIVATE_KEY!,
    accountIndex: parseInt(process.env.ACCOUNT_INDEX!),
    apiKeyIndex: parseInt(process.env.API_KEY_INDEX!)
  });

  // Initialize WASM signer (required)
  await signerClient.initialize();
  await signerClient.ensureWasmClient();

  // Create a market order with SL/TP
  const result = await signerClient.createUnifiedOrder({
    marketIndex: 0,              // ETH market
    clientOrderIndex: Date.now(), // Unique ID
    baseAmount: 10000,           // 0.01 ETH (scaled: 1 ETH = 1,000,000)
    isAsk: false,                // BUY (true = SELL)
    orderType: OrderType.MARKET,
    
    // Slip page protection
    idealPrice: 400000,           // Ideal price ($4000)
    maxSlippage: 0.001,           // Max 0.1% slippage
    
    // Automatic stop-loss and take-profit
    stopLoss: {
      triggerPrice: 380000,       // Stop loss at $3800
      isLimit: false              // Market SL
    },
    takeProfit: {
      triggerPrice: 420000,       // Take profit at $4200
      isLimit: false              // Market TP
    }
  });

  // Check if order succeeded
  if (!result.success) {
    console.error('❌ Order failed:', result.mainOrder.error);
    return;
  }

  console.log('✅ Order created!');
  console.log('Main order hash:', result.mainOrder.hash);
  console.log('SL order hash:', result.stopLoss?.hash);
  console.log('TP order hash:', result.takeProfit?.hash);

  // Wait for transaction confirmation
  await signerClient.waitForTransaction(result.mainOrder.hash, 30000);
  
  await signerClient.close();
}

placeOrder().catch(console.error);