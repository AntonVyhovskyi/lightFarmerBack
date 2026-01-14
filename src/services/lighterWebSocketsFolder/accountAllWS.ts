import WebSocket from 'ws';

export function subscribeToAccountAllWS(accountIndex: number, onMessage: (data: any) => void, onError: (error: any) => void) {
    const ws = new WebSocket(`wss://mainnet.zklighter.elliot.ai/stream`);

    ws.on("open", () => {
        ws.send(JSON.stringify({
            type: "subscribe",
            channel: `account_all/${accountIndex}`,
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
// const ws = subscribeToAccountAllWS(277234, (data) => {
//     console.log('Received data:', data);
// }, (error) => {
//     console.error('WebSocket error:', error);
// });
