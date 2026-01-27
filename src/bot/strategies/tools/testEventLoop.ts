export function startEventLoopLagMonitor() {
    console.log('Event loop lag monitor STARTED');
    let last = Date.now();

    setInterval(() => {
        const now = Date.now();
        const drift = now - last - 1000;
        if (drift > 200) {
            console.log('EVENT LOOP LAG', drift, 'ms');
        }
        last = now;
    }, 1000);
}