import WebSocket from 'ws';
import { getSigner } from '../lighterSdkFolder/client';




export async function subscribeToAccountAllOrdersWS(accountIndex: number, onMessage: (data: any) => void, onError: (error: any) => void) {

    const signer = await getSigner();
    const authToken = await signer.createAuthToken();
    console.log("authToken:", authToken, typeof authToken);


    const ws = new WebSocket(`wss://mainnet.zklighter.elliot.ai/stream`);
    
    ws.on("open", () => {
        console.log('WebSocket connection opened for account all orders stream.', accountIndex);
        ws.send(JSON.stringify({
            type: "subscribe",
            channel: `account_all_orders/${accountIndex}`,
            auth: authToken
        }));

    });


    ws.on('message', (data) => {
        onMessage(JSON.parse(data.toString()));
    });

    ws.on('error', (error) => {
        onError(error);
    });
    ws.on('close', () => {
        console.log('WebSocket connection closed for account all orders stream.', accountIndex);
    });
    return ws;
}




// Example usage:
// (async () => {
//     const ws = await subscribeToAccountAllOrdersWS(
//         277234,
//         (data) => {console.log("Received:", data)
//             console.log("Orders:", data.orders);
//         },
//         (err) => console.error("WS error:", err)
//     );
// })();
