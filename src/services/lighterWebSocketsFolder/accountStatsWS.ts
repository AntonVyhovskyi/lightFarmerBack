import WebSocket from 'ws';

export function subscribeToAccountStatsWS(accountIndex: number, onMessage: (data: any) => void, onError: (error: any) => void) {
    const ws = new WebSocket(`wss://mainnet.zklighter.elliot.ai/stream`);

    ws.on("open", () => {
        
        
        ws.send(JSON.stringify({
            type: "subscribe",
            channel: `user_stats/${accountIndex}`,
        }));
    });


    ws.on('message', (data) => {
        onMessage(JSON.parse(data.toString()));
    });

    ws.on('error', (error) => {
        onError(error);
    });
    ws.on('close', () => {
        console.log('WebSocket connection closed for user stats stream.', accountIndex);
    });
    return ws;
}


// Example usage:
// (async () => {
//     const ws = await subscribeToAccountStatsWS(
//         277234,
//         (data) => {console.log("Received:", data)
//             console.log("Received:", data);
//         },
//         (err) => console.error("WS error:", err)
//     );
// })();