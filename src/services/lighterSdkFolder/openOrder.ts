import { getSigner } from "./client";
import { OrderType } from 'lighter-ts-sdk';



export async function openOrder(marketIndex: number = 0, isAsk: boolean = false, baseAmount: number, idealPrice: number, stopLossTrigger: number, takeProfitTrigger?: number, maxSlippage: number = 0.001) {
    const signer = await getSigner();
    if (!baseAmount) {
        throw new Error("Base amount is required to open an order.");
    }
    try {
         const result = await signer.createUnifiedOrder({
        marketIndex,              // ETH market
        clientOrderIndex: Date.now(), // Unique ID
        baseAmount,           // 0.01 ETH (scaled: 1 ETH = 1,000,000)
        isAsk,                // BUY (true = SELL)
        orderType: OrderType.MARKET,

        // Slip page protection
        idealPrice,           // Ideal price ($4000)
        maxSlippage,           // Max 0.1% slippage

        // Automatic stop-loss and take-profit
        stopLoss: {
            triggerPrice: stopLossTrigger,       // Stop loss at $3800
            isLimit: false              // Market SL
        },
        // takeProfit: {
        //     triggerPrice: takeProfitTrigger,       // Take profit at $4200
        //     isLimit: false              // Market TP
        // }
    });
    console.log(result);
    
    return result;
    } catch (error) {
        console.log(error);
        return error;
        
    }
   
}

// openOrder(2, false, 100 , 141700, 0.001, 138000, 143000).then((result) => {
//     console.log('Order Result:', result);
//     console.log(result.stopLoss?.tx.Orders);
    
// }).catch((error) => {
//     console.error('Error placing order:', error);
// });