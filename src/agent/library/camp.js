// Personal camp for bots WITHOUT an owner-set home: the spot a bot claims by
// itself for its own chest/crafting table/furnace, persisted to
// bots/<name>/camp.json. Unlike the base.js home it never leashes the bot, never
// sets the respawn point and never drives watchdog teleports — it only remembers
// where this bot keeps its personal storage, like a normal player's first camp.
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Vec3 } from 'vec3';
import { log } from './skills.js';

const campCache = new WeakMap();

function campFile(bot) { return `./bots/${bot.username}/camp.json`; }

function dimensionKey(bot) { return String(bot.game?.dimension ?? 'world'); }

export function getCamp(bot) {
    if (!campCache.has(bot)) {
        try { campCache.set(bot, JSON.parse(readFileSync(campFile(bot), 'utf8'))); }
        catch { campCache.set(bot, null); }
    }
    const camp = campCache.get(bot);
    if (!camp || camp.dimension !== dimensionKey(bot)) {
        bot._personalCamp = null;
        return null;
    }
    bot._personalCamp = camp;
    return camp;
}

export function setCamp(bot, x, y, z) {
    const camp = {
        x: Math.floor(x),
        y: Math.floor(y),
        z: Math.floor(z),
        dimension: dimensionKey(bot),
        claimedAt: new Date().toISOString(),
    };
    const file = campFile(bot);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(camp, null, 2));
    campCache.set(bot, camp);
    bot._personalCamp = camp;
    log(bot, `Tukaj pri ${camp.x},${camp.y},${camp.z} si uredim svoj kotiček za skrinjo.`);
    return camp;
}

export function clearCamp(bot) {
    try { unlinkSync(campFile(bot)); } catch { /* none saved */ }
    campCache.set(bot, null);
    bot._personalCamp = null;
}

// A camp may only be claimed under open sky, so a mid-mining stash never anchors
// the bot's personal storage inside a cave. Leaves above still count as open —
// settling under a tree is fine.
export function canClaimCampHere(bot) {
    if (!bot.entity) return false;
    const pos = bot.entity.position.floored();
    const worldMinY = bot.game?.minY ?? 0;
    const maxY = worldMinY + (bot.game?.height ?? 256) - 1;
    for (let y = pos.y + 2; y <= Math.min(pos.y + 48, maxY); y++) {
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z), false);
        if (!block) return false; // column not loaded — cannot tell, do not claim
        if (block.boundingBox !== 'empty' && !block.name.includes('leaves')) return false;
    }
    return true;
}
