import { createMindServer } from '../src/mindcraft/mindserver.js';

const requestedPort = Number(process.env.MINDSERVER_PORT ?? process.argv[2] ?? 8080);
await createMindServer(false, requestedPort);
