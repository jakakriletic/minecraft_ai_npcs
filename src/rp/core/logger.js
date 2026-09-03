// Simple prefixed logger: every NPC logs as [Name] message, with timestamp.
export function makeLogger(prefix) {
    const stamp = () => new Date().toLocaleTimeString('sl-SI');
    return {
        info: (...args) => console.log(`${stamp()} [${prefix}]`, ...args),
        warn: (...args) => console.warn(`${stamp()} [${prefix}] WARN:`, ...args),
        error: (...args) => console.error(`${stamp()} [${prefix}] ERROR:`, ...args),
    };
}
