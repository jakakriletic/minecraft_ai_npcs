import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this.running = false;
        this.stopping = false;
        this.restartAttempts = 0;
        this.restartTimer = null;
        this.stopTimer = null;
        this.killTimer = null;
    }

    start(load_memory=false, init_message=null, count_id=0) {
        this.count_id = count_id;
        this.running = true;
        this.stopping = false;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.clearStopTimers();

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
        });
        
        const startedAt = Date.now();
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            this.clearStopTimers();
            logoutAgent(this.name);
            if (this.process === agentProcess)
                this.process = null;
            
            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (!this.stopping && code !== 0 && signal !== 'SIGINT') {
                const runtime = Date.now() - startedAt;
                this.restartAttempts = runtime > 60000 ? 0 : this.restartAttempts + 1;
                const delay = Math.min(30000, 2000 * (2 ** Math.min(this.restartAttempts, 4)));
                console.log(`Restarting ${this.name} in ${Math.round(delay / 1000)}s...`);
                this.restartTimer = setTimeout(() => {
                    this.restartTimer = null;
                    this.start(true, 'Agent process restarted.', count_id);
                }, delay);
            }
        });
    
        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
        });

        this.process = agentProcess;
    }

    clearStopTimers() {
        clearTimeout(this.stopTimer);
        clearTimeout(this.killTimer);
        this.stopTimer = null;
        this.killTimer = null;
    }

    stop(forceAfterMs=8000) {
        this.stopping = true;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        this.clearStopTimers();
        if (!this.running || !this.process) return;

        const child = this.process;
        child.kill('SIGINT');

        this.stopTimer = setTimeout(() => {
            if (this.process !== child || !this.running) return;
            console.warn(`Agent ${this.name} did not stop after SIGINT; sending SIGTERM.`);
            child.kill('SIGTERM');

            this.killTimer = setTimeout(() => {
                if (this.process !== child || !this.running) return;
                console.warn(`Agent ${this.name} still did not stop; force killing.`);
                child.kill('SIGKILL');
            }, 3000);
        }, forceAfterMs);
    }

    forceRestart() {
        this.stopping = false;
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);

            this.process.once('exit', () => {
                 console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                 this.stopping = false;
                 this.start(true, 'Agent process restarted.', this.count_id);
            });
            this.stop(5000);
        } else {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}
