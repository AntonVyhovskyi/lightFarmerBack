import WebSocket from 'ws';

export async function subscribeToAccountAllWS(accountIndex: number, onMessage: (data: any) => void, onError: (error: any) => void) {


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

        ws.on("open", () => {

            ws.send(JSON.stringify({
                type: "subscribe",
                channel: `account_all/${accountIndex}`,
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
                channel: `account_all/${accountIndex}`,
                code,
                reason: reason?.toString(),
            });

            if (manualStop) return;

            // реконектимось на ненормальні кейси
            if (code === 1006 || code === 1008 || code === 1011 || code === 1012 || code === 1005) {
                setTimeout(() => void connect(), 1000);
            }
        });
    }
    await connect();

    return handle;
}




// Example usage:
// const ws = subscribeToAccountAllWS(277234, (data) => {
//     // console.log('Received data:', data);
// }, (error) => {
//     // console.error('WebSocket error:', error);
// });
