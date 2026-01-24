import { getSigner } from "./client";

export async function closePosition(marketIndex: number, baseAmount: number, isAsk: boolean, avgExecutionPrice: number ) {
    const signer = await getSigner();
    const [tx, hash, error] = await signer.createMarketOrder({
        marketIndex,
        clientOrderIndex: Date.now(),
        baseAmount,        // Position size to close
        avgExecutionPrice,
        isAsk,              // Opposite of position
        reduceOnly: true          // IMPORTANT: Only closes, doesn't open new
    });
    if (error) {
        console.error('Close failed:', error);
        return;
    }
    await signer.waitForTransaction(hash);
    console.log('✅ Position closed');
}

// closePosition(2, 100, true, 141700).then(() => {
//     console.log('Close position request completed.');
// }).catch((error) => {
//     console.error('Error closing position:', error);
// });