import WebSocket from 'ws';

export function subscribeToAccountAllWS(accountIndex: number, onMessage: (data: any) => void, onError: (error: any) => void) {
    const ws = new WebSocket(`wss://mainnet.zklighter.elliot.ai/stream`);



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
    });
    return ws;
}




// Example usage:
// const ws = subscribeToAccountAllWS(277234, (data) => {
//     // console.log('Received data:', data);
// }, (error) => {
//     // console.error('WebSocket error:', error);
// });
