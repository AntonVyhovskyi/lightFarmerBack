export const getCandlesFromBinance = async (symbol: string  = "ETH", interval: string = "1m", limit: number = 100) => {
    try {
        let fixedSymbolString
        if (symbol === 'BTC') {
            fixedSymbolString = 'BTCUSDC'
        } else if (symbol === 'ETH') {
            fixedSymbolString = 'ETHUSDC'
        } else if (symbol === 'SOL') {
            fixedSymbolString = 'SOLUSDC'
        }
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${fixedSymbolString}&interval=${interval}&limit=${limit}`);
        const data = await response.json();
        return data;
    } catch (error) {
        console.log(error);

    }

}

// example usage:
// (async () => {
//     const candles = await getCandlesFromBinance("ETH", "1m", 10);
//     console.log(candles);
// })();