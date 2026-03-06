export const getCandlesFromBinance = async (symbol: string = "ETH", interval: string = "1m", limit: number = 100): Promise<any[][]> => {
    try {
        let fixedSymbolString
        if (symbol === 'BTC') {
            fixedSymbolString = 'BTCUSDC'
        } else if (symbol === 'ETH') {
            fixedSymbolString = 'ETHUSDC'
        } else if (symbol === 'SOL') {
            fixedSymbolString = 'SOLUSDC'
        } else if (symbol === 'LIT') {
            fixedSymbolString = 'LITUSDT'
        }
        const response = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${fixedSymbolString}&interval=${interval}&limit=${limit}`);
        const data = await response.json() as any[][];
        return data;
    } catch (error) {
        console.log(error);
        throw error;
    }

}

// example usage:
// (async () => {
//     const candles = await getCandlesFromBinance("ETH", "1m", 10);
//     console.log(candles);
// })();