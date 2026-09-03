import { existsSync, readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { io } from 'socket.io-client';

const runtimeFile = path.resolve(process.cwd(), 'bots', 'kingdom-runtime.json');
const command = (process.argv[2] || 'status').toLowerCase();

function readRuntime() {
    if (!existsSync(runtimeFile)) return null;
    try {
        return JSON.parse(readFileSync(runtimeFile, 'utf8'));
    } catch (err) {
        console.error(`Runtime file is not valid JSON: ${err.message}`);
        return null;
    }
}

function removeRuntimeFile() {
    try {
        unlinkSync(runtimeFile);
    } catch {
        // Already gone.
    }
}

function isRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForExit(pid, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!isRunning(pid)) return true;
        await wait(300);
    }
    return !isRunning(pid);
}

function taskkillTree(pid) {
    return new Promise(resolve => {
        if (process.platform !== 'win32') return resolve(false);
        const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'inherit',
            windowsHide: true,
        });
        child.on('exit', code => resolve(code === 0));
        child.on('error', () => resolve(false));
    });
}

function requestGracefulShutdown(runtime, timeoutMs = 5000) {
    const port = Number(runtime?.mindserverPort);
    if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false);

    return new Promise(resolve => {
        const socket = io(`http://127.0.0.1:${port}`, {
            reconnection: false,
            timeout: timeoutMs,
        });
        let settled = false;
        const finish = ok => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        socket.once('connect_error', () => finish(false));
        socket.once('connect', () => {
            socket.timeout(timeoutMs).emit('shutdown', (error, response) => {
                finish(!error && response?.ok === true);
            });
        });
    });
}

function status() {
    const runtime = readRuntime();
    const pid = Number(runtime?.mainPid);
    if (!runtime || !isRunning(pid)) {
        console.log('Kingdom is not running.');
        if (runtime) removeRuntimeFile();
        return 1;
    }

    console.log(`Kingdom is running. PID ${pid}, started ${runtime.startedAt || 'unknown time'}.`);
    return 0;
}

async function stop() {
    const runtime = readRuntime();
    const pid = Number(runtime?.mainPid);
    if (!runtime || !isRunning(pid)) {
        console.log('Kingdom is not running.');
        if (runtime) removeRuntimeFile();
        return 0;
    }

    console.log(`Stopping kingdom PID ${pid}...`);
    const gracefulRequested = await requestGracefulShutdown(runtime);
    if (!gracefulRequested) {
        console.warn('MindServer did not acknowledge shutdown; falling back to SIGINT.');
        try {
            process.kill(pid, 'SIGINT');
        } catch (err) {
            console.warn(`Could not send SIGINT: ${err.message}`);
        }
    }

    if (await waitForExit(pid, 15000)) {
        removeRuntimeFile();
        console.log(gracefulRequested ? 'Kingdom stopped cleanly.' : 'Kingdom stopped after signal fallback.');
        return 0;
    }

    console.warn('Kingdom did not stop cleanly; sending SIGTERM.');
    try {
        process.kill(pid, 'SIGTERM');
    } catch (err) {
        console.warn(`Could not send SIGTERM: ${err.message}`);
    }

    if (await waitForExit(pid, 5000)) {
        removeRuntimeFile();
        console.log('Kingdom stopped.');
        return 0;
    }

    console.warn('Kingdom is still running; force killing process tree.');
    await taskkillTree(pid);
    const stopped = await waitForExit(pid, 5000);
    if (stopped) {
        removeRuntimeFile();
        console.log('Kingdom force-stopped.');
        return 0;
    }

    console.error(`Could not stop kingdom PID ${pid}.`);
    return 1;
}

let exitCode = 0;
if (command === 'status') {
    exitCode = status();
} else if (command === 'stop') {
    exitCode = await stop();
} else {
    console.error(`Unknown command: ${command}`);
    exitCode = 2;
}
process.exit(exitCode);
