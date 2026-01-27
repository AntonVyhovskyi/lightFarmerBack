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
        const text = data.toString();


        if (text === 'ping') {
            ws.send('pong');
            return;
        }


        try {
            const msg = JSON.parse(text);

            if (msg?.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            onMessage(msg);
        } catch {

            console.log('NON-JSON:', text);
        }

    });
    ws.on('ping', () => ws.pong())


    ws.on('error', (error) => {
        onError(error);
    });

    ws.on('close', (code, reason) => {
       
        console.log('WS closed', {
            channel: `user_stats/${accountIndex}`,
            code,
            reason: reason?.toString(),
        });
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