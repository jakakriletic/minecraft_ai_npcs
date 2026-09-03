const COLOR_META = {
    white: 0,
    orange: 1,
    magenta: 2,
    light_blue: 3,
    yellow: 4,
    lime: 5,
    pink: 6,
    gray: 7,
    light_gray: 8,
    cyan: 9,
    purple: 10,
    blue: 11,
    brown: 12,
    green: 13,
    red: 14,
    black: 15,
};

const COLOR_BY_META = Object.fromEntries(Object.entries(COLOR_META).map(([name, metadata]) => [metadata, name]));

const WOOD_META = {
    oak: { block: 'log', metadata: 0 },
    spruce: { block: 'log', metadata: 1 },
    birch: { block: 'log', metadata: 2 },
    jungle: { block: 'log', metadata: 3 },
    acacia: { block: 'log2', metadata: 0 },
    dark_oak: { block: 'log2', metadata: 1 },
};

const WOOD_BY_LEGACY = {
    log: ['oak', 'spruce', 'birch', 'jungle'],
    log2: ['acacia', 'dark_oak'],
};

const FLOWER_META = {
    poppy: { block: 'red_flower', metadata: 0 },
    blue_orchid: { block: 'red_flower', metadata: 1 },
    allium: { block: 'red_flower', metadata: 2 },
    azure_bluet: { block: 'red_flower', metadata: 3 },
    red_tulip: { block: 'red_flower', metadata: 4 },
    orange_tulip: { block: 'red_flower', metadata: 5 },
    white_tulip: { block: 'red_flower', metadata: 6 },
    pink_tulip: { block: 'red_flower', metadata: 7 },
    oxeye_daisy: { block: 'red_flower', metadata: 8 },
};

const SIMPLE_BLOCK_FALLBACKS = {
    air: 'air',
    cave_air: 'air',
    void_air: 'air',
    grass_block: 'grass',
    dirt_path: 'grass_path',
    bricks: 'brick_block',
    sugar_cane: 'reeds',
    short_grass: 'tallgrass',
    tall_grass: 'tallgrass',
    stone_bricks: 'stonebrick',
    cobbled_deepslate: 'cobblestone',
    deepslate: 'stone',
    deepslate_tiles: 'stonebrick',
    blackstone: 'cobblestone',
    polished_blackstone: 'stonebrick',
    polished_blackstone_bricks: 'stonebrick',
    polished_blackstone_brick_wall: 'cobblestone_wall',
    stone_brick_wall: 'cobblestone_wall',
    smooth_stone: 'stone',
    smooth_quartz: 'quartz_block',
    sea_lantern: 'glowstone',
    lantern: 'torch',
    soul_lantern: 'torch',
    campfire: 'torch',
    chain: 'iron_bars',
    barrel: 'chest',
    blast_furnace: 'furnace',
    smoker: 'furnace',
    composter: 'cauldron',
    lectern: 'bookshelf',
    carved_pumpkin: 'pumpkin',
    stripped_oak_log: 'log',
    stripped_spruce_log: 'log',
    stripped_birch_log: 'log',
    stripped_jungle_log: 'log',
    stripped_acacia_log: 'log2',
    stripped_dark_oak_log: 'log2',
    wall_torch: 'torch',
    door: 'wooden_door',
};

const SIMPLE_ITEM_FALLBACKS = {
    ...SIMPLE_BLOCK_FALLBACKS,
    raw_iron: 'iron_ore',
    raw_gold: 'gold_ore',
    lapis_lazuli: 'dye',
    bone_meal: 'dye',
    cocoa_beans: 'dye',
    charcoal: 'coal',
    cod: 'fish',
    salmon: 'fish',
    tropical_fish: 'fish',
    cooked_cod: 'cooked_fish',
    cooked_salmon: 'cooked_fish',
};

// Pre-flattening block-state variants: a burning furnace on legacy servers is its own
// block ('lit_furnace'), so any search for 'furnace' must keep matching it or
// bots "lose" their furnace the moment somebody starts smelting in it.
const LEGACY_BLOCK_VARIANTS = {
    furnace: ['lit_furnace'],
};

const ITEM_META = {
    raw_iron: 0,
    raw_gold: 0,
    lapis_lazuli: 4,
    cocoa_beans: 3,
    bone_meal: 15,
    charcoal: 1,
    cod: 0,
    salmon: 1,
    tropical_fish: 2,
    cooked_cod: 0,
    cooked_salmon: 1,
};

const LEGACY_METADATA_MASKS = {
    log: 3,
    log2: 3,
    leaves: 3,
    leaves2: 3,
    sapling: 7,
    wooden_slab: 7,
    stone_slab: 7,
};

const LEGACY_VARIANT_METADATA_BLOCKS = new Set([
    'planks', 'wool', 'carpet', 'concrete', 'stained_glass',
    'stained_glass_pane', 'stained_hardened_clay', 'dirt', 'stonebrick',
    'stone', 'red_flower',
]);

function parseVersion(version) {
    const match = String(version ?? '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3] ?? 0),
    };
}

export function isPreFlatteningVersion(source) {
    const version = typeof source === 'string' ? source : source?.version ?? source?.minecraft_version;
    const parsed = parseVersion(version);
    return Boolean(parsed && (parsed.major < 1 || (parsed.major === 1 && parsed.minor < 13)));
}

export function usesLegacyNames(source) {
    const version = typeof source === 'string' ? source : source?.version ?? source?.minecraft_version;
    return isPreFlatteningVersion(version);
}

// Minecraft 1.18 expanded the Overworld from Y=0..255 to Y=-64..319 and moved
// the useful mining layers. Keep this separate from name flattening (1.13), as
// versions 1.13-1.17 use modern registry names but still have the old world floor.
export function usesExpandedWorldHeight(source) {
    const version = typeof source === 'string' ? source : source?.version ?? source?.minecraft_version;
    const parsed = parseVersion(version);
    if (!parsed || parsed.major !== 1) return false;
    return parsed.minor >= 18;
}

export function stripNamespaceAndState(name) {
    return String(name ?? '')
        .replace(/^minecraft:/, '')
        .replace(/\[.*\]$/, '');
}

export function isBedBlock(blockOrName) {
    const rawName = typeof blockOrName === 'string' ? blockOrName : blockOrName?.name;
    const clean = stripNamespaceAndState(rawName);
    return clean === 'bed' || clean.endsWith('_bed');
}

// Wire index of the Ageable/Zombie "is baby" metadata flag. It moved across
// protocol eras: pre-1.14 uses 12, 1.14-1.16 uses 15 (pose was
// inserted at 6), and 1.17+ uses 16 (frozen ticks inserted at 7). Reading the
// reading a modern index on a legacy server yields undefined, so baby checks can
// treated calves/chicks as adults.
export function babyMetadataIndex(source) {
    const version = typeof source === 'string' ? source : source?.version ?? source?.minecraft_version;
    const parsed = parseVersion(version);
    if (!parsed || parsed.major !== 1) return 16;
    if (parsed.minor <= 13) return 12;
    if (parsed.minor <= 16) return 15;
    return 16;
}

export function isBabyEntity(entity, source = null) {
    const value = entity?.metadata?.[babyMetadataIndex(source)];
    return value === true || value === 1;
}

function namespaced(name) {
    if (String(name).includes(':')) return String(name);
    return `minecraft:${name}`;
}

function colorName(name, suffix) {
    const end = `_${suffix}`;
    if (!name.endsWith(end)) return null;
    const color = name.slice(0, -end.length);
    return COLOR_META[color] == null ? null : color;
}

function woodName(name, suffix) {
    const end = `_${suffix}`;
    if (!name.endsWith(end)) return null;
    const wood = name.slice(0, -end.length);
    return WOOD_META[wood] ? wood : null;
}

function withMeta(name, metadata = 0) {
    return { name, metadata };
}

export function legacyBlockSpec(blockName, source = null) {
    const clean = stripNamespaceAndState(blockName);
    if (!usesLegacyNames(source)) return { name: clean, metadata: null };

    const stripped = clean.startsWith('stripped_') ? clean.slice('stripped_'.length) : null;
    const strippedWood = stripped ? (woodName(stripped, 'log') ?? woodName(stripped, 'wood')) : null;
    if (strippedWood) return withMeta(WOOD_META[strippedWood].block, WOOD_META[strippedWood].metadata);

    const logWood = woodName(clean, 'log') ?? woodName(clean, 'wood');
    if (logWood) return withMeta(WOOD_META[logWood].block, WOOD_META[logWood].metadata);

    const leavesWood = woodName(clean, 'leaves');
    if (leavesWood) {
        const legacy = WOOD_META[leavesWood].block === 'log2' ? 'leaves2' : 'leaves';
        return withMeta(legacy, WOOD_META[leavesWood].metadata);
    }

    const planksWood = woodName(clean, 'planks');
    if (planksWood) return withMeta('planks', WOOD_META[planksWood].metadata);

    const slabWood = woodName(clean, 'slab');
    if (slabWood) return withMeta('wooden_slab', WOOD_META[slabWood].metadata);

    const saplingWood = woodName(clean, 'sapling');
    if (saplingWood) return withMeta('sapling', WOOD_META[saplingWood].metadata);

    const doorWood = woodName(clean, 'door');
    if (doorWood === 'oak') return withMeta('wooden_door', 0);

    const fenceWood = woodName(clean, 'fence');
    if (fenceWood === 'oak') return withMeta('fence', 0);

    const gateWood = woodName(clean, 'fence_gate');
    if (gateWood === 'oak') return withMeta('fence_gate', 0);

    const buttonWood = woodName(clean, 'button');
    if (buttonWood) return withMeta('wooden_button', 0);

    const pressurePlateWood = woodName(clean, 'pressure_plate');
    if (pressurePlateWood) return withMeta('wooden_pressure_plate', 0);

    const trapdoorWood = woodName(clean, 'trapdoor');
    if (trapdoorWood) return withMeta('trapdoor', 0);

    const signWood = woodName(clean, 'sign');
    if (signWood) return withMeta('standing_sign', 0);

    const bedColor = colorName(clean, 'bed');
    if (bedColor) return withMeta('bed', 0);

    const woolColor = colorName(clean, 'wool');
    if (woolColor) return withMeta('wool', COLOR_META[woolColor]);

    const carpetColor = colorName(clean, 'carpet');
    if (carpetColor) return withMeta('carpet', COLOR_META[carpetColor]);

    const concreteColor = colorName(clean, 'concrete');
    if (concreteColor) return withMeta('concrete', COLOR_META[concreteColor]);

    const glassColor = colorName(clean, 'stained_glass');
    if (glassColor) return withMeta('stained_glass', COLOR_META[glassColor]);

    const glassPaneColor = colorName(clean, 'stained_glass_pane');
    if (glassPaneColor) return withMeta('stained_glass_pane', COLOR_META[glassPaneColor]);

    const terracottaColor = colorName(clean, 'terracotta');
    if (terracottaColor) return withMeta('stained_hardened_clay', COLOR_META[terracottaColor]);

    if (clean === 'stone_brick_slab') return withMeta('stone_slab', 5);
    if (clean === 'chiseled_stone_bricks') return withMeta('stonebrick', 3);
    if (clean === 'coarse_dirt') return withMeta('dirt', 1);
    if (clean === 'podzol') return withMeta('dirt', 2);
    if (clean === 'polished_andesite') return withMeta('stone', 6);
    if (clean === 'polished_diorite') return withMeta('stone', 4);
    if (clean === 'polished_granite') return withMeta('stone', 2);
    if (clean === 'dandelion') return withMeta('yellow_flower', 0);
    if (FLOWER_META[clean]) return withMeta(FLOWER_META[clean].block, FLOWER_META[clean].metadata);

    const fallback = SIMPLE_BLOCK_FALLBACKS[clean] ?? clean;
    return withMeta(fallback, 0);
}

export function legacyItemSpec(itemName, source = null) {
    const clean = stripNamespaceAndState(itemName);
    if (!usesLegacyNames(source)) return { name: clean, metadata: null };

    const bedColor = colorName(clean, 'bed');
    if (bedColor) return withMeta('bed', COLOR_META[bedColor]);

    if (woodName(clean, 'sign')) return withMeta('sign', 0);
    if (clean === 'oak_boat') return withMeta('boat', 0);

    const blockSpec = legacyBlockSpec(clean, source);
    if (blockSpec.name !== clean || blockSpec.metadata !== 0)
        return blockSpec;

    const fallback = SIMPLE_ITEM_FALLBACKS[clean] ?? clean;
    return withMeta(fallback, ITEM_META[clean] ?? 0);
}

export function setBlockCommand(x, y, z, blockName, source = null, handling = 'replace') {
    if (usesLegacyNames(source)) {
        const spec = legacyBlockSpec(blockName, source);
        return `/setblock ${x} ${y} ${z} ${namespaced(spec.name)} ${spec.metadata ?? 0} ${handling}`;
    }
    return `/setblock ${x} ${y} ${z} ${namespaced(blockName)} ${handling}`;
}

export function fillCommand(min, max, blockName, source = null, handling = 'replace') {
    if (usesLegacyNames(source)) {
        const spec = legacyBlockSpec(blockName, source);
        return `/fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} ${namespaced(spec.name)} ${spec.metadata ?? 0} ${handling}`;
    }
    return `/fill ${min.x} ${min.y} ${min.z} ${max.x} ${max.y} ${max.z} ${namespaced(blockName)} ${handling}`;
}

export function aliasesForLegacyStack(name, metadata = 0, source = null) {
    if (!usesLegacyNames(source)) return [name];
    const clean = stripNamespaceAndState(name);
    const meta = Number(metadata ?? 0);
    const aliases = new Set([clean]);

    if (WOOD_BY_LEGACY[clean]) {
        const wood = WOOD_BY_LEGACY[clean][meta & 3];
        if (wood) {
            aliases.add(`${wood}_log`);
            aliases.add(`${wood}_wood`);
        }
    } else if (clean === 'leaves' || clean === 'leaves2') {
        const wood = WOOD_BY_LEGACY[clean === 'leaves2' ? 'log2' : 'log']?.[meta & 3];
        if (wood) aliases.add(`${wood}_leaves`);
    } else if (clean === 'planks') {
        const wood = Object.keys(WOOD_META)[meta & 7];
        if (wood) aliases.add(`${wood}_planks`);
    } else if (clean === 'wooden_slab') {
        const wood = Object.keys(WOOD_META)[meta & 7];
        if (wood) aliases.add(`${wood}_slab`);
    } else if (clean === 'wooden_door') {
        aliases.add('door');
        aliases.add('oak_door');
    } else if (clean === 'fence') {
        aliases.add('oak_fence');
    } else if (clean === 'fence_gate') {
        aliases.add('oak_fence_gate');
    } else if (clean === 'wooden_button') {
        aliases.add('oak_button');
    } else if (clean === 'wooden_pressure_plate') {
        aliases.add('oak_pressure_plate');
    } else if (clean === 'trapdoor') {
        aliases.add('oak_trapdoor');
    } else if (clean === 'sign') {
        aliases.add('oak_sign');
    } else if (clean === 'boat') {
        aliases.add('oak_boat');
    } else if (clean === 'bed') {
        aliases.add(`${COLOR_BY_META[meta] ?? 'white'}_bed`);
    } else if (clean === 'sapling') {
        const wood = Object.keys(WOOD_META)[meta & 7];
        if (wood) aliases.add(`${wood}_sapling`);
    } else if (clean === 'grass') {
        aliases.add('grass_block');
    } else if (clean === 'dirt') {
        if (meta === 1) aliases.add('coarse_dirt');
        if (meta === 2) aliases.add('podzol');
    } else if (clean === 'grass_path') {
        aliases.add('dirt_path');
    } else if (clean === 'reeds') {
        aliases.add('sugar_cane');
    } else if (clean === 'stonebrick') {
        aliases.add(meta === 3 ? 'chiseled_stone_bricks' : 'stone_bricks');
    } else if (clean === 'stone') {
        if (meta === 2) aliases.add('polished_granite');
        if (meta === 4) aliases.add('polished_diorite');
        if (meta === 6) aliases.add('polished_andesite');
    } else if (clean === 'stone_slab' && meta === 5) {
        aliases.add('stone_brick_slab');
    } else if (clean === 'brick_block') {
        aliases.add('bricks');
    } else if (clean === 'wool') {
        aliases.add(`${COLOR_BY_META[meta] ?? 'white'}_wool`);
    } else if (clean === 'carpet') {
        aliases.add(`${COLOR_BY_META[meta] ?? 'white'}_carpet`);
    } else if (clean === 'concrete') {
        aliases.add(`${COLOR_BY_META[meta] ?? 'white'}_concrete`);
    } else if (clean === 'stained_glass') {
        aliases.add(`${COLOR_BY_META[meta] ?? 'white'}_stained_glass`);
    } else if (clean === 'stained_glass_pane') {
        aliases.add(`${COLOR_BY_META[meta] ?? 'white'}_stained_glass_pane`);
    } else if (clean === 'stained_hardened_clay') {
        aliases.add(`${COLOR_BY_META[meta] ?? 'white'}_terracotta`);
    } else if (clean === 'dye') {
        if (meta === 4) aliases.add('lapis_lazuli');
        if (meta === 15) aliases.add('bone_meal');
        if (meta === 3) aliases.add('cocoa_beans');
    } else if (clean === 'coal' && meta === 1) {
        aliases.add('charcoal');
    } else if (clean === 'fish') {
        aliases.add(meta === 1 ? 'salmon' : meta === 2 ? 'tropical_fish' : 'cod');
    } else if (clean === 'cooked_fish') {
        aliases.add(meta === 1 ? 'cooked_salmon' : 'cooked_cod');
    } else if (clean === 'iron_ore') {
        aliases.add('raw_iron');
    } else if (clean === 'gold_ore') {
        aliases.add('raw_gold');
    } else if (clean === 'torch') {
        aliases.add('wall_torch');
        aliases.add('lantern');
    } else if (clean === 'chest') {
        aliases.add('barrel');
    } else if (clean === 'furnace') {
        aliases.add('smoker');
        aliases.add('blast_furnace');
    }

    return [...aliases];
}

export function stackMatchesName(stack, requestedName, source = null) {
    if (!stack || !requestedName) return false;
    const requested = stripNamespaceAndState(requestedName);
    if (stack.name === requested) return true;
    const spec = legacyItemSpec(requested, source);
    if (usesLegacyNames(source)
        && stack.name === spec.name
        && (spec.metadata == null || Number(stack.metadata ?? 0) === Number(spec.metadata ?? 0))) {
        return true;
    }
    return aliasesForLegacyStack(stack.name, stack.metadata, source).includes(requested);
}

export function stackMatchesAnyName(stack, requestedNames, source = null) {
    return (Array.isArray(requestedNames) ? requestedNames : [requestedNames])
        .some(name => stackMatchesName(stack, name, source));
}

export function findInventoryItem(bot, requestedName) {
    return bot?.inventory?.items?.().find(item => stackMatchesName(item, requestedName, bot)) ?? null;
}

// Resolving block names -> numeric ids runs legacyBlockSpec() (regex-heavy) and is called
// on every getNearestBlocks() search in the hot mining/gathering path. The block registry
// is static per MC version, so memoize by version+names. NOTE: callers must treat the
// returned array as read-only (do not mutate) — it is shared.
const _blockIdCache = new Map();
export function registryBlockIds(bot, names) {
    const list = Array.isArray(names) ? names : [names];
    const key = `${bot?.version ?? ''}|${list.join(',')}`;
    const cached = _blockIdCache.get(key);
    if (cached) return cached;
    const ids = new Set();
    for (const rawName of list) {
        const clean = stripNamespaceAndState(rawName);
        const direct = bot?.registry?.blocksByName?.[clean]?.id;
        if (Number.isInteger(direct)) ids.add(direct);
        const spec = legacyBlockSpec(clean, bot);
        const legacy = bot?.registry?.blocksByName?.[spec.name]?.id;
        if (Number.isInteger(legacy)) ids.add(legacy);
        for (const variant of LEGACY_BLOCK_VARIANTS[clean] ?? LEGACY_BLOCK_VARIANTS[spec.name] ?? []) {
            const variantId = bot?.registry?.blocksByName?.[variant]?.id;
            if (Number.isInteger(variantId)) ids.add(variantId);
        }
    }
    const result = [...ids];
    _blockIdCache.set(key, result);
    return result;
}

export function blockMatchesName(block, expectedName, source = null) {
    if (!block || !expectedName) return false;
    const actualName = typeof block === 'string' ? block : block.name;
    const actualMetadata = typeof block === 'string' ? 0 : Number(block.metadata ?? 0);
    const expected = stripNamespaceAndState(expectedName);
    if (actualName === expected) return true;
    if ((LEGACY_BLOCK_VARIANTS[expected] ?? []).includes(actualName)) return true;
    if (!usesLegacyNames(source)) return false;
    const spec = legacyBlockSpec(expected, source);
    if (actualName !== spec.name) return false;
    if (spec.metadata == null) return true;
    if (LEGACY_METADATA_MASKS[spec.name] != null)
        return (actualMetadata & LEGACY_METADATA_MASKS[spec.name]) === spec.metadata;

    if (LEGACY_VARIANT_METADATA_BLOCKS.has(spec.name)) return actualMetadata === spec.metadata;

    // For beds, doors, buttons and other directional/toggleable blocks, legacy
    // metadata represents block state rather than the modern material/name.
    return true;
}

export function blockMatchesAnyName(block, expectedNames, source = null) {
    return (Array.isArray(expectedNames) ? expectedNames : [expectedNames])
        .some(name => blockMatchesName(block, name, source));
}
