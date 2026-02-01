import WebSocket from 'ws';
import { getSigner } from '../lighterSdkFolder/client';




export async function subscribeToAccountOrdersWS(accountIndex: number, marketIndex: number, onMessage: (data: any) => void, onError: (error: any) => void) {

    const signer = await getSigner();



    let current: WebSocket | null = null;
    let manualStop = false;

    const handle = {
        get readyState() {
            return current?.readyState ?? WebSocket.CLOSED;
        },
        close() {
            manualStop = true;
            try {
                current?.close(1000, "manual stop");
            } catch { }
        },
        getWS() {
            return current;
        },
    };

    const connect = async () => {
        if (manualStop) return;
        const ws = new WebSocket(`wss://mainnet.zklighter.elliot.ai/stream`);
        current = ws;
        const authToken = await signer.createAuthToken();

        ws.on("open", () => {
            console.log('WebSocket connection opened for account orders stream.', accountIndex);
            ws.send(JSON.stringify({
                type: "subscribe",
                channel: `account_orders/${marketIndex}/${accountIndex}`,
                auth: authToken
            }));

        });

        ws.on('ping', () => {

            ws.pong()
        })


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

        ws.on('error', (error) => {
            onError(error);
        });
        ws.on('close', (code, reason) => {
            console.log('WS closed', {
                channel: `account_orders/${marketIndex}/${accountIndex}`,
                code,
                reason: reason?.toString(),
            });
            if (manualStop) return;

            // реконектимось на ненормальні кейси
            if (code === 1006 || code === 1008 || code === 1011 || code === 1012 || code === 1005) {
                setTimeout(() => void connect(), 1000);
            }


        });
        return ws;
    };



    await connect();
    return handle;



}




// Example usage:
// (async () => {
//     const ws = await subscribeToAccountOrdersWS(
//         277234,
//         2,
//         (data) => {console.log("Received:", data)
//             console.log("Orders:", data.orders);
//         },
//         (err) => console.error("WS error:", err)
//     );
// })();
