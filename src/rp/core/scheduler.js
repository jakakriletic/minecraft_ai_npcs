// Scheduler: decides the NPC's current activity from in-game time of day.
// Phase 1: fixed blocks only (work / sleep / free). Free-time choice comes in later phases.
//
// Minecraft timeOfDay: 0..24000 ticks. 0 = dawn (6:00), 6000 = noon, 12000 = dusk, 18000 = midnight.

// Returns true if `t` lies in [start, end), handling wrap-around past 24000.
function inWindow(t, start, end) {
    if (start <= end) return t >= start && t < end;
    return t >= start || t < end; // window wraps midnight
}

export function validateSchedule(schedule, log) {
    // Sleep must never overlap work. If it does, push sleep_start to work_end.
    const { work_start, work_end, sleep_start, sleep_end } = schedule;
    const overlaps =
        inWindow(sleep_start, work_start, work_end) ||
        inWindow(work_start, sleep_start, sleep_end);
    if (overlaps) {
        log.warn(`schedule: sleep overlaps work, moving sleep_start ${sleep_start} -> ${work_end}`);
        schedule.sleep_start = work_end;
    }
    return schedule;
}

// Returns 'work' | 'sleep' | 'free' for the given in-game time of day.
export function activityFor(schedule, timeOfDay) {
    if (inWindow(timeOfDay, schedule.work_start, schedule.work_end)) return 'work';
    if (inWindow(timeOfDay, schedule.sleep_start, schedule.sleep_end)) return 'sleep';
    return 'free';
}

// Human-readable in-game clock for logs, e.g. "13:30".
export function igClock(timeOfDay) {
    const totalMin = ((timeOfDay / 1000) + 6) % 24 * 60;
    const h = Math.floor(totalMin / 60);
    const m = Math.floor(totalMin % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
