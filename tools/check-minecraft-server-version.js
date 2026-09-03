import { getServer } from '../src/mindcraft/mcserver.js';

const [host = '127.0.0.1', portText = '25565', expectedVersion = '1.20.1'] = process.argv.slice(2);
const port = Number(portText);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Neveljaven Minecraft port: ${portText}`);
    process.exitCode = 1;
} else {
    try {
        const server = await getServer(host, port, expectedVersion);
        console.log(`Preverjeno: ${server.host}:${server.port} uporablja Minecraft Java ${server.version}.`);
    } catch (error) {
        console.error(`Preverjanje streznika ni uspelo: ${error.message}`);
        process.exitCode = 1;
    }
}
