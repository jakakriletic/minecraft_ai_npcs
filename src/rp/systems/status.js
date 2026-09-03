import { activityFor, igClock } from '../core/scheduler.js';
import { isInRegion } from '../core/movement.js';
import * as mcCompat from '../../utils/mc_compat.js';
import { FOOD_NAMES } from './food.js';

const DEFAULT_INTERVAL_MS = 60_000;
const LOADED_RADIUS = 88;

const BED_NAMES = [
    'bed',
    'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed',
    'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed',
    'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed',
    'brown_bed', 'green_bed', 'red_bed', 'black_bed',
];
const CHEST_NAMES = ['chest', 'trapped_chest', 'barrel'];
const FURNACE_NAMES = ['furnace', 'lit_furnace', 'smoker', 'blast_furnace'];
const CRAFTING_NAMES = ['crafting_table', 'workbench'];
const AXE_NAMES = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe', 'golden_axe'];
const PICKAXE_NAMES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe'];
const SWORD_NAMES = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'golden_sword'];
const TOOL_REQUIREMENTS = {
    woodcutter: { label: 'axe', names: AXE_NAMES },
    miner: { label: 'pickaxe', names: PICKAXE_NAMES },
    gatherer: { label: 'pickaxe', names: PICKAXE_NAMES },
    guard: { label: 'sword', names: SWORD_NAMES },
    policeman: { label: 'sword', names: SWORD_NAMES },
};

const WORKSHOP_REQUIREMENTS = {
    cook: [
        { label: 'furnace', names: FURNACE_NAMES, blocker: true },
        { label: 'crafting table', names: CRAFTING_NAMES, blocker: true },
        { label: 'chest', names: CHEST_NAMES, blocker: false },
    ],
    innkeeper: [
        { label: 'chest', names: CHEST_NAMES, blocker: false },
    ],
    builder: [
        { label: 'chest', names: CHEST_NAMES, blocker: false },
        { label: 'crafting table', names: CRAFTING_NAMES, blocker: false },
    ],
    steward: [
        { label: 'town storage chest', names: CHEST_NAMES, blocker: true },
    ],
};

export function attachSocietyStatus(npc, civic = null) {
    if (npc.settings.society?.enabled === false) return;
    const interval = Math.max(10_000, Number(npc.settings.society?.status_interval_ms ?? DEFAULT_INTERVAL_MS));
    const timer = setInterval(() => safeSocietyTick(npc, civic), interval);
    npc.bot.once('end', () => clearInterval(timer));
    setTimeout(() => safeSocietyTick(npc, civic), Math.min(5000, interval));
}

export function societyTick(npc, civic = null) {
    const status = getSocietyStatus(npc);
    rememberSocietyStatus(npc, status);

    if (civic && npc.registry?.[0] === npc) {
        const statuses = npc.registry.map(other => getSocietyStatus(other));
        civic.recordComplianceSnapshot?.(statuses);
    }
    return status;
}

export function safeSocietyTick(npc, civic = null) {
    try {
        return societyTick(npc, civic);
    } catch (error) {
        npc.log?.warn?.(`society status: ${error.message}`);
        return null;
    }
}

export function getSocietyStatus(npc) {
    const bot = npc.bot;
    const blockers = [];
    const warnings = [];
    const structures = {};

    const online = Boolean(bot?.entity);
    if (!online) blockers.push('NPC ni online');

    const timeOfDay = bot?.time?.timeOfDay;
    const expectedActivity = expectedActivityFor(npc, timeOfDay);
    const expectedRegion = expectedRegionFor(npc, expectedActivity);
    const currentRegionOk = checkCurrentRegion(npc, expectedRegion, expectedActivity, blockers, warnings);

    checkRegions(npc, blockers, warnings);
    checkStructures(npc, structures, blockers, warnings);
    checkNeeds(npc, blockers, warnings);
    checkTools(npc, blockers, warnings);
    checkWorkshop(npc, structures, blockers, warnings);
    checkTax(npc, blockers, warnings);

    if (npc.command) warnings.push(`admin ukaz preglasi rutino: ${npc.command.type}`);
    if (npc.pendingAction) warnings.push('caka enkratno opravilo pred rutino');

    const score = complianceScore(blockers, warnings);
    return {
        npc_id: npc.cfg.id,
        name: npc.cfg.osebnost?.ime ?? npc.cfg.id,
        job: npc.cfg.job ?? 'idle',
        online,
        activity: npc.currentActivity ?? null,
        expected_activity: expectedActivity,
        expected_region: expectedRegion,
        current_region_ok: currentRegionOk,
        clock: Number.isFinite(timeOfDay) ? igClock(timeOfDay) : null,
        score,
        ready: blockers.length === 0,
        blockers,
        warnings,
        structures,
    };
}

export function rememberSocietyStatus(npc, status = getSocietyStatus(npc)) {
    if (!npc.state?.data) return status;
    const previous = npc.state.data.society ?? {};
    const signature = JSON.stringify({
        score: status.score,
        blockers: status.blockers,
        warnings: status.warnings.slice(0, 5),
        expected_activity: status.expected_activity,
        expected_region: status.expected_region,
    });
    npc.state.data.society = {
        last_checked_at: new Date().toISOString(),
        compliance_score: status.score,
        ready: status.ready,
        expected_activity: status.expected_activity,
        expected_region: status.expected_region,
        current_region_ok: status.current_region_ok,
        blockers: status.blockers.slice(0, 8),
        warnings: status.warnings.slice(0, 8),
        structures: status.structures,
        last_fix: previous.last_fix ?? null,
        fix_history: previous.fix_history ?? [],
        last_job: previous.last_job ?? null,
        job_history: previous.job_history ?? [],
        signature,
    };
    if (previous.signature !== signature || !previous.last_checked_at) npc.state.save();
    return status;
}

export function formatSocietyStatus(npc) {
    const status = getSocietyStatus(npc);
    rememberSocietyStatus(npc, status);
    const state = status.ready ? 'OK' : 'BLOCKED';
    const region = status.expected_region ?? 'prosto';
    const blockers = status.blockers.length ? status.blockers.slice(0, 4).join(' | ') : 'ni';
    const warnings = status.warnings.length ? status.warnings.slice(0, 3).join(' | ') : 'ni';
    const lastFix = npc.state?.data?.society?.last_fix;
    const lastFixText = lastFix ? `${lastFix.type}:${lastFix.success ? 'ok' : 'fail'} (${lastFix.detail})` : 'ni';
    const lastJob = npc.state?.data?.society?.last_job;
    const lastJobText = lastJob ? `${lastJob.kind} (${lastJob.detail})` : 'ni';
    return [
        `society: ${state} ${status.score}% | ura ${status.clock ?? '?'} | rutina ${status.expected_activity ?? '?'} -> ${region}`,
        `blockerji: ${blockers}`,
        `opozorila: ${warnings}`,
        `zadnji popravek: ${lastFixText}`,
        `zadnji job: ${lastJobText}`,
        `strukture: ${formatStructureSummary(status.structures)}`,
    ];
}

export function formatTownSocietyStatus(npcs = [], civic = null) {
    const statuses = npcs.map(npc => getSocietyStatus(npc));
    civic?.recordComplianceSnapshot?.(statuses);
    if (!statuses.length) return ['Society: ni NPCjev v registru.'];

    const total = statuses.length;
    const ready = statuses.filter(s => s.ready).length;
    const avg = Math.round(statuses.reduce((sum, s) => sum + s.score, 0) / total);
    const blocked = statuses.filter(s => s.blockers.length);
    const worst = statuses
        .slice()
        .sort((a, b) => a.score - b.score)
        .slice(0, 3)
        .map(s => `${s.name}:${s.score}%${s.blockers[0] ? ` (${s.blockers[0]})` : ''}`)
        .join(' | ');
    const line1 = `Society: ${ready}/${total} OK | compliance ${avg}% | blokirani: ${blocked.map(s => s.name).join(', ') || 'nihce'}`;
    const line2 = `Najprej popravi: ${worst || 'ni vidnih tezav'}`;
    return [line1, line2];
}

function expectedActivityFor(npc, timeOfDay) {
    if (isJailed(npc)) return 'jail';
    if (npc.forcedActivity) return npc.forcedActivity;
    if (Number.isFinite(timeOfDay) && npc.schedule) return activityFor(npc.schedule, timeOfDay);
    return npc.currentActivity ?? null;
}

function expectedRegionFor(npc, activity) {
    if (activity === 'jail') return npc.locations.zapor ? 'zapor' : npc.cfg.home_region;
    if (activity === 'sleep') return npc.cfg.home_region;
    if (activity === 'work') return npc.cfg.job_region;
    return null;
}

function checkCurrentRegion(npc, expectedRegionName, expectedActivity, blockers, warnings) {
    if (!expectedRegionName || !npc.bot?.entity) return null;
    if (npc.command) return null;
    const region = npc.locations[expectedRegionName];
    if (!region) return null;
    const ok = isInRegion(npc.bot, region);
    if (!ok && expectedActivity) {
        blockers.push(`ni v regiji '${expectedRegionName}' za rutino '${expectedActivity}'`);
    }
    if (expectedActivity === 'sleep' && ok && !npc.bot.isSleeping) {
        warnings.push('je doma, ampak ni v postelji');
    }
    return ok;
}

function checkRegions(npc, blockers, warnings) {
    if (!npc.cfg.home_region) blockers.push('nima nastavljenega doma');
    else if (!npc.locations[npc.cfg.home_region]) blockers.push(`dom '${npc.cfg.home_region}' ne obstaja`);

    if (npc.cfg.job !== 'idle') {
        if (!npc.cfg.job_region) blockers.push('nima nastavljenega delovnega regiona');
        else if (!npc.locations[npc.cfg.job_region]) blockers.push(`delovni region '${npc.cfg.job_region}' ne obstaja`);
    }

    const law = npc.civic?.taxLaw?.();
    if (law?.storage_region && !npc.locations[law.storage_region]) {
        blockers.push(`mestna zaloga '${law.storage_region}' ne obstaja`);
    }

    const wageRegion = npc.settings.economy?.obcinska_skrinja_regija ?? 'obcina';
    if (npc.cfg.job !== 'idle' && !npc.locations[wageRegion]) {
        warnings.push(`placilni region '${wageRegion}' ne obstaja`);
    }
}

function checkStructures(npc, structures, blockers, warnings) {
    structures.home = checkRegionBlocks(npc, npc.cfg.home_region, [
        { key: 'bed', label: 'bed', names: BED_NAMES, min: 1 },
    ]);
    const homeBed = structures.home?.checks?.bed;
    if (homeBed?.loaded && homeBed.count < 1) blockers.push(`dom '${npc.cfg.home_region}' nima postelje`);
    if (homeBed && !homeBed.loaded) warnings.push(`dom '${npc.cfg.home_region}' ni nalozen, postelja ni preverjena`);

    const law = npc.civic?.taxLaw?.();
    if (law?.storage_region) {
        structures.town_storage = checkRegionBlocks(npc, law.storage_region, [
            { key: 'chest', label: 'chest', names: CHEST_NAMES, min: 1 },
        ]);
        const chest = structures.town_storage?.checks?.chest;
        if (chest?.loaded && chest.count < 1) blockers.push(`mestna zaloga '${law.storage_region}' nima skrinje`);
        if (chest && !chest.loaded) warnings.push(`mestna zaloga '${law.storage_region}' ni nalozena, skrinja ni preverjena`);
    }

    const wageRegion = npc.settings.economy?.obcinska_skrinja_regija ?? 'obcina';
    if (npc.locations[wageRegion]) {
        structures.town_hall = checkRegionBlocks(npc, wageRegion, [
            { key: 'chest', label: 'chest', names: CHEST_NAMES, min: 1 },
        ]);
        const chest = structures.town_hall?.checks?.chest;
        if (chest?.loaded && chest.count < 1) warnings.push(`obcina '${wageRegion}' nima placilne skrinje`);
    }
}

function checkTools(npc, blockers, warnings) {
    const req = TOOL_REQUIREMENTS[npc.cfg.job];
    if (!req) return;
    const tool = inventoryOrStored(npc, req.names);
    if (tool.inventory) return;
    if (tool.home || tool.town) {
        warnings.push(`${req.label} ni pri sebi (${tool.home ? 'doma' : 'v mestni zalogi'})`);
        return;
    }
    blockers.push(`manjka ${req.label} za delo '${npc.cfg.job}'`);
}

function checkWorkshop(npc, structures, blockers, warnings) {
    const reqs = WORKSHOP_REQUIREMENTS[npc.cfg.job];
    if (!reqs?.length || !npc.cfg.job_region) return;
    structures.work = checkRegionBlocks(npc, npc.cfg.job_region, reqs.map(req => ({
        key: req.label,
        label: req.label,
        names: req.names,
        min: 1,
    })));
    const work = structures.work;
    if (!work?.loaded) {
        warnings.push(`delovni region '${npc.cfg.job_region}' ni nalozen, oprema ni preverjena`);
        return;
    }
    for (const req of reqs) {
        const check = work.checks?.[req.label];
        if (!check || check.count >= 1) continue;
        const msg = `${npc.cfg.job_region} nima: ${req.label}`;
        if (req.blocker) blockers.push(msg);
        else warnings.push(msg);
    }

    if (npc.cfg.job === 'cook') {
        const food = inventoryOrStored(npc, FOOD_NAMES);
        if (!food.inventory && !food.home && !food.town) warnings.push('kuhar nima vidne hrane v inventarju ali znani zalogi');
    }
}

function checkNeeds(npc, blockers, warnings) {
    const p = npc.state?.data?.potrebe;
    if (!p) return;
    if (p.sitost < 40) blockers.push(`kriticno lacen (sitost ${Math.round(p.sitost)})`);
    else if (p.sitost < 85) warnings.push(`lacen (sitost ${Math.round(p.sitost)})`);

    if (p.utrujenost > 85) blockers.push(`preutrujen (utrujenost ${Math.round(p.utrujenost)})`);
    else if (p.utrujenost > 70) warnings.push(`utrujen (utrujenost ${Math.round(p.utrujenost)})`);

    if (p.druzabnost < 15) warnings.push(`osamljen (druzabnost ${Math.round(p.druzabnost)})`);
}

function checkTax(npc, blockers, warnings) {
    const civic = npc.civic;
    const law = civic?.taxLaw?.();
    const bot = npc.bot;
    if (!law || !bot?.time) return;
    const day = civic.data?.current_day ?? civic.dayFromBot?.(bot);
    if (!Number.isFinite(day) || civic.hasPaidTax?.(npc.cfg.id, day)) return;

    const timeOfDay = bot.time.timeOfDay;
    const taxable = taxableInventoryValue(npc, law);
    if (timeOfDay >= Number(law.grace_until_tick ?? 17_000) && taxable > 0) {
        blockers.push(`mestni prispevek zamujen (${taxable} kosov v inventarju)`);
    } else if (timeOfDay >= Number(law.due_after_tick ?? 9000) && taxable > 0) {
        warnings.push(`mestni prispevek se ni oddan (${taxable} kosov)`);
    }
}

function checkRegionBlocks(npc, regionName, checks) {
    const region = npc.locations[regionName];
    if (!region) return { region: regionName, exists: false, loaded: false, checks: {} };
    const loaded = regionLooksLoaded(npc.bot, region);
    const result = { region: regionName, exists: true, loaded, checks: {} };
    for (const check of checks) {
        result.checks[check.key] = {
            label: check.label,
            count: loaded ? countBlocksInRegion(npc.bot, region, check.names) : null,
            min: check.min ?? 1,
            loaded,
        };
    }
    return result;
}

function regionLooksLoaded(bot, region) {
    if (!bot?.entity || !region?.center) return false;
    const p = bot.entity.position;
    const c = region.center;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    return Math.sqrt(dx * dx + dz * dz) <= Math.max(LOADED_RADIUS, (region.radius ?? 0) + 32);
}

function countBlocksInRegion(bot, region, names) {
    if (!bot?.findBlocks || !region?.center) return 0;
    const positions = bot.findBlocks({
        point: region.center,
        matching: block => mcCompat.blockMatchesAnyName(block, names, bot),
        maxDistance: (region.radius ?? 0) + 4,
        count: 32,
    });
    return positions.length;
}

function inventoryOrStored(npc, names) {
    const inventory = Boolean(npc.bot?.inventory?.items?.().some(item => mcCompat.stackMatchesAnyName(item, names, npc.bot)));
    const home = countStoredAny(npc, names, npc.cfg.home_region) > 0;
    const town = countStoredAny(npc, names, 'mestna_zaloga') > 0;
    return { inventory, home, town };
}

function countStoredAny(npc, names, regionName) {
    if (!regionName || !npc.storage?.totalOf) return 0;
    return names.reduce((sum, name) => sum + Number(npc.storage.totalOf(name, regionName) ?? 0), 0);
}

function taxableInventoryValue(npc, law) {
    const applies = law.applies_to ?? [];
    let total = 0;
    for (const item of npc.bot?.inventory?.items?.() ?? []) {
        if (mcCompat.stackMatchesAnyName(item, applies, npc.bot)) total += item.count;
    }
    return total;
}

function isJailed(npc) {
    const until = npc.state?.data?.zapor_do;
    return Boolean(until && new Date(until) > new Date());
}

function complianceScore(blockers, warnings) {
    return Math.max(0, Math.min(100, 100 - blockers.length * 18 - warnings.length * 6));
}

function formatStructureSummary(structures) {
    const parts = [];
    if (structures.home) parts.push(`dom ${formatStructure(structures.home)}`);
    if (structures.work) parts.push(`delo ${formatStructure(structures.work)}`);
    if (structures.town_storage) parts.push(`zaloga ${formatStructure(structures.town_storage)}`);
    if (structures.town_hall) parts.push(`obcina ${formatStructure(structures.town_hall)}`);
    return parts.join(' | ') || 'ni preverjenih struktur';
}

function formatStructure(structure) {
    if (!structure.exists) return 'manjka';
    if (!structure.loaded) return 'ni nalozeno';
    const checks = Object.values(structure.checks ?? {})
        .map(check => `${check.label}:${check.count}/${check.min}`)
        .join(',');
    return checks || 'ok';
}
