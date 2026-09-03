// Temp diagnostic: drive a live agent through chest commands via the MindServer
// and capture its output, to see why chests "instantly close" on some bots.
import { io } from 'socket.io-client';

const AGENT = process.argv[2] ?? 'Zan';
const CMD = process.argv[3] ?? '!viewChest';

const socket = io('http://localhost:8080');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

socket.on('connect', () => {
    log('connected to mindserver');
    socket.emit('listen-to-agents');
    setTimeout(() => {
        log(`sending to ${AGENT}: ${CMD}`);
        socket.emit('send-message', AGENT, { from: 'ADMIN', message: CMD });
    }, 500);
});
socket.on('bot-output', (agentName, message) => {
    if (agentName === AGENT) log(`[${agentName}]`, String(message).slice(0, 500));
});
socket.on('connect_error', e => { log('connect_error', e.message); process.exit(1); });

setTimeout(() => { log('done listening'); process.exit(0); }, 90000);
