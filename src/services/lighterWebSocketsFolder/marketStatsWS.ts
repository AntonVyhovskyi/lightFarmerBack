import WebSocket from 'ws';

export function subscribeToMarketStatsWS(marketIndex: number, onMessage: (data: any) => void, onError: (error: any) => void) {
    const ws = new WebSocket(`wss://mainnet.zklighter.elliot.ai/stream`);

    ws.on("open", () => {
        ws.send(JSON.stringify({
            type: "subscribe",
            channel: `market_stats/${marketIndex}`,
        }));
    });


    ws.on('message', (data) => {
        onMessage(JSON.parse(data.toString()));
    });

    ws.on('error', (error) => {
        onError(error);
    });
    ws.on('close', () => {
        console.log('WebSocket connection closed for account all stream.', accountIndex);
    });
    return ws;
}


// Example usage:
// (async () => {
//     const ws = await subscribeToMarketStatsWS(
//         2,
//         (data) => {console.log("Received:", data)
           
//         },
//         (err) => console.error("WS error:", err)
//     );
// })();