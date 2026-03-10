import { log } from 'node:console';
import WebSocket from 'ws';

export function subscribeBinanceCandlesWS(symbol: string, interval: string, onClose: (candle: string[]) => void) {
    let fixedSymbolString
    if (symbol === 'BTC') {
        fixedSymbolString = 'btcusdc'
    } else if (symbol === 'ETH') {
        fixedSymbolString = 'ethusdc'
    } else if (symbol === 'SOL') {
        fixedSymbolString = 'solusdc'
    } else if (symbol === 'LIT') {
        fixedSymbolString = 'litusdt'
    }
    const wsUrl = `wss://fstream.binance.com/ws/${fixedSymbolString}@kline_${interval}`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => console.log(`WS підключено: ${symbol} ${interval}`));

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        const k = msg.k || msg.kline;
        if (!k) return;

        if (k.x) { // закрита свічка
            const candleArray = [
                k.t,                 // 0 openTime
                k.o,     // 1 open
                k.h,     // 2 high
                k.l,     // 3 low
                k.c,     // 4 close
                k.v,     // 5 volume
                k.T,                 // 6 closeTime
                k.q || 0, // 7 quoteVolume, якщо є
                k.n || 0,            // 8 number of trades
                k.V || 0, // 9 taker buy base
                k.Q || 0, // 10 taker buy quote
                0                     // 11 ігноруємо
            ];
            log(`Закрита свічка для ${symbol} ${interval}:`, candleArray);
            onClose(candleArray);
        }
    });

    ws.on('error', (err) => console.error("WS Error:", err));
    ws.on('close', () => console.log("WS закрито"));

    return ws;
}


// Приклад використання:
// (async () => {
//     const unsubscribe = subscribeBinanceCandlesWS('BTC', '1m', (candle) => {
//         console.log('Закрита свічка:', candle);
//     });
// })()
