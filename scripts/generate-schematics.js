import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cwd } from 'process';

const OUTPUT_DIR = join(cwd(), 'schematics');
mkdirSync(OUTPUT_DIR, { recursive: true });

class Blueprint {
    constructor(name, size, metadata) {
        this.name = name;
        this.size = size;
        this.metadata = metadata;
        this.blocks = new Map();
    }

    key(x, y, z) {
        return `${x},${y},${z}`;
    }

    set(x, y, z, name) {
        const [width, height, depth] = this.size;
        if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth)
            throw new Error(`${this.name}: block outside size at ${x},${y},${z}`);
        if (name) this.blocks.set(this.key(x, y, z), { x, y, z, name });
        else this.blocks.delete(this.key(x, y, z));
        return this;
    }

    fill(x1, y1, z1, x2, y2, z2, name) {
        for (let y = y1; y <= y2; y++)
            for (let z = z1; z <= z2; z++)
                for (let x = x1; x <= x2; x++)
                    this.set(x, y, z, name);
        return this;
    }

    column(x, z, y1, y2, name) {
        return this.fill(x, y1, z, x, y2, z, name);
    }

    save() {
        const blocks = [...this.blocks.values()]
            .sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
        const data = {
            _opis: this.metadata.description,
            _category: this.metadata.category,
            _kind: this.metadata.kind ?? 'building',
            _aliases: this.metadata.aliases ?? [],
            size: this.size,
            blocks,
        };
        writeFileSync(join(OUTPUT_DIR, `${this.name}.json`), `${JSON.stringify(data, null, 2)}\n`);
        return blocks.length;
    }
}

function perimeter(plan, y, block, inset = 0) {
    const [width, , depth] = plan.size;
    plan.fill(inset, y, inset, width - 1 - inset, y, inset, block);
    plan.fill(inset, y, depth - 1 - inset, width - 1 - inset, y, depth - 1 - inset, block);
    plan.fill(inset, y, inset, inset, y, depth - 1 - inset, block);
    plan.fill(width - 1 - inset, y, inset, width - 1 - inset, y, depth - 1 - inset, block);
}

function addDoor(plan, x, z, door) {
    plan.set(x, 1, z, door);
    plan.set(x, 2, z, null);
}

function addHouseWindows(plan, wallHeight, glass) {
    const [width, , depth] = plan.size;
    const frontXs = [...new Set([2, width - 3])].filter(x => x > 0 && x < width - 1);
    const sideZs = [...new Set([2, depth - 3])].filter(z => z > 0 && z < depth - 1);
    const windowYs = wallHeight >= 7 ? [2, 5] : [2];
    for (const y of windowYs) {
        for (const x of frontXs) {
            plan.set(x, y, 0, glass);
            plan.set(x, y, depth - 1, glass);
        }
        for (const z of sideZs) {
            plan.set(0, y, z, glass);
            plan.set(width - 1, y, z, glass);
        }
    }
}

function addGableRoof(plan, wallHeight, roof) {
    const [width, , depth] = plan.size;
    const layers = Math.ceil(depth / 2);
    for (let layer = 0; layer < layers; layer++) {
        const y = wallHeight + 1 + layer;
        const frontZ = layer;
        const backZ = depth - 1 - layer;
        plan.fill(0, y, frontZ, width - 1, y, frontZ, roof);
        if (backZ !== frontZ)
            plan.fill(0, y, backZ, width - 1, y, backZ, roof);
    }
}

function addFlatRoof(plan, wallHeight, roof, parapet = null) {
    const [width, , depth] = plan.size;
    plan.fill(0, wallHeight + 1, 0, width - 1, wallHeight + 1, depth - 1, roof);
    if (parapet) perimeter(plan, wallHeight + 2, parapet);
}

function house(config) {
    const roofExtra = config.roofType === 'flat' ? 3 : Math.ceil(config.depth / 2) + 2;
    const plan = new Blueprint(
        config.name,
        [config.width, config.wallHeight + roofExtra, config.depth],
        config,
    );
    plan.fill(0, 0, 0, config.width - 1, 0, config.depth - 1, config.floor);
    for (let y = 1; y <= config.wallHeight; y++) perimeter(plan, y, config.wall);

    for (const [x, z] of [[0, 0], [config.width - 1, 0], [0, config.depth - 1], [config.width - 1, config.depth - 1]])
        plan.column(x, z, 1, config.wallHeight, config.frame);

    if (config.wallHeight >= 7)
        plan.fill(1, 4, 1, config.width - 2, 4, config.depth - 2, config.floor);

    addHouseWindows(plan, config.wallHeight, config.glass);
    addDoor(plan, Math.floor(config.width / 2), 0, config.door);

    if (config.roofType === 'flat')
        addFlatRoof(plan, config.wallHeight, config.roof, config.parapet);
    else
        addGableRoof(plan, config.wallHeight, config.roof);

    plan.set(1, 1, 1, 'crafting_table');
    plan.set(config.width - 2, 1, 1, 'furnace');
    plan.set(config.width - 2, 1, config.depth - 2, 'chest');
    if (config.chimney) {
        const x = config.width - 2;
        const z = config.depth - 2;
        plan.column(x, z, config.wallHeight + 1, plan.size[1] - 1, config.chimney);
    }
    if (config.accent) {
        plan.fill(1, config.wallHeight, 0, config.width - 2, config.wallHeight, 0, config.accent);
        plan.fill(1, config.wallHeight, config.depth - 1, config.width - 2, config.wallHeight, config.depth - 1, config.accent);
    }
    return plan;
}

function medievalWatchtower() {
    const plan = new Blueprint('medieval_watchtower', [7, 13, 7], {
        description: 'Visok srednjeveski strazni stolp z lesenim vrhom.',
        category: 'medieval',
        aliases: ['strazni stolp'],
    });
    plan.fill(0, 0, 0, 6, 0, 6, 'stone_bricks');
    for (let y = 1; y <= 8; y++) perimeter(plan, y, y < 5 ? 'stone_bricks' : 'spruce_planks');
    for (const [x, z] of [[0, 0], [6, 0], [0, 6], [6, 6]])
        plan.column(x, z, 1, 9, 'spruce_log');
    addDoor(plan, 3, 0, 'spruce_door');
    for (const [x, z] of [[3, 6], [0, 3], [6, 3]])
        plan.set(x, 6, z, 'glass');
    plan.fill(0, 9, 0, 6, 9, 6, 'dark_oak_planks');
    perimeter(plan, 10, 'stone_bricks');
    for (const [x, z] of [[0, 0], [2, 0], [4, 0], [6, 0], [0, 6], [2, 6], [4, 6], [6, 6], [0, 2], [0, 4], [6, 2], [6, 4]])
        plan.set(x, 11, z, 'stone_bricks');
    return plan;
}

function medievalChapel() {
    const plan = house({
        name: 'medieval_chapel',
        description: 'Majhna kamnita kapela z visokim barvnim oknom.',
        category: 'medieval',
        aliases: ['kapela', 'cerkev'],
        width: 9,
        depth: 13,
        wallHeight: 5,
        wall: 'stone_bricks',
        frame: 'cobblestone',
        floor: 'polished_andesite',
        glass: 'yellow_stained_glass',
        door: 'dark_oak_door',
        roof: 'deepslate_tiles',
        roofType: 'gable',
    });
    plan.set(4, 2, 12, 'red_stained_glass');
    plan.set(4, 3, 12, 'yellow_stained_glass');
    plan.set(4, 4, 12, 'red_stained_glass');
    plan.fill(3, 1, 9, 5, 1, 9, 'oak_planks');
    plan.set(4, 2, 9, 'lantern');
    return plan;
}

function medievalStable() {
    const plan = new Blueprint('medieval_stable', [13, 12, 11], {
        description: 'Prostoren srednjeveski hlev s stirimi boksi in senikom.',
        category: 'medieval',
        aliases: ['hlev', 'stable', 'konjusnica'],
    });
    plan.fill(0, 0, 0, 12, 0, 10, 'coarse_dirt');
    for (let y = 1; y <= 4; y++) perimeter(plan, y, 'spruce_planks');
    for (const [x, z] of [[0, 0], [4, 0], [8, 0], [12, 0], [0, 10], [4, 10], [8, 10], [12, 10]])
        plan.column(x, z, 1, 6, 'dark_oak_log');
    plan.fill(1, 4, 1, 11, 4, 9, 'spruce_planks');
    addGableRoof(plan, 5, 'dark_oak_planks');
    plan.fill(5, 1, 0, 7, 3, 0, null);
    for (const x of [3, 6, 9]) {
        plan.column(x, 1, 1, 3, 'spruce_fence');
        plan.column(x, 5, 1, 3, 'spruce_fence');
        plan.set(x, 1, 3, 'spruce_fence_gate');
        plan.set(x, 1, 7, 'spruce_fence_gate');
    }
    for (const [x, z] of [[1, 2], [11, 2], [1, 8], [11, 8]])
        plan.set(x, 1, z, 'hay_block');
    plan.set(6, 5, 5, 'lantern');
    plan.set(1, 1, 9, 'chest');
    return plan;
}

function medievalGatehouse() {
    const plan = new Blueprint('medieval_gatehouse', [15, 12, 7], {
        description: 'Masivna srednjeveska mestna vrata z dvema straznima stolpoma.',
        category: 'medieval',
        aliases: ['mestna vrata', 'gatehouse', 'grajska vrata'],
    });
    plan.fill(0, 0, 0, 14, 0, 6, 'stone_bricks');
    for (const [x1, x2] of [[0, 4], [10, 14]]) {
        for (let y = 1; y <= 8; y++)
            plan.fill(x1, y, 0, x2, y, 6, y <= 3 ? 'cobblestone' : 'stone_bricks');
        plan.fill(x1 + 1, 1, 1, x2 - 1, 7, 5, null);
        plan.fill(x1, 9, 0, x2, 9, 0, 'stone_bricks');
        plan.fill(x1, 9, 6, x2, 9, 6, 'stone_bricks');
        plan.fill(x1, 9, 0, x1, 9, 6, 'stone_bricks');
        plan.fill(x2, 9, 0, x2, 9, 6, 'stone_bricks');
    }
    plan.fill(5, 5, 0, 9, 8, 6, 'stone_bricks');
    plan.fill(6, 1, 0, 8, 4, 6, null);
    plan.fill(5, 9, 0, 9, 9, 6, 'dark_oak_planks');
    for (const x of [0, 2, 4, 10, 12, 14])
        for (const z of [0, 6])
            plan.set(x, 10, z, 'stone_bricks');
    for (const x of [5, 7, 9])
        for (const z of [0, 6])
            plan.set(x, 10, z, 'stone_bricks');
    plan.fill(6, 1, 2, 8, 4, 2, 'iron_bars');
    plan.set(2, 6, 0, 'iron_bars');
    plan.set(12, 6, 0, 'iron_bars');
    plan.set(7, 7, 1, 'lantern');
    return plan;
}

function medievalWindmill() {
    const plan = new Blueprint('medieval_windmill', [13, 17, 9], {
        description: 'Visok lesen srednjeveski mlin z velikimi kriznimi lopaticami.',
        category: 'medieval',
        aliases: ['mlin', 'windmill', 'vetrni mlin'],
    });
    plan.fill(3, 0, 2, 9, 0, 8, 'stone_bricks');
    for (let y = 1; y <= 10; y++) {
        const inset = y >= 7 ? 1 : 0;
        plan.fill(3 + inset, y, 2 + inset, 9 - inset, y, 2 + inset, 'spruce_planks');
        plan.fill(3 + inset, y, 8 - inset, 9 - inset, y, 8 - inset, 'spruce_planks');
        plan.fill(3 + inset, y, 2 + inset, 3 + inset, y, 8 - inset, 'spruce_planks');
        plan.fill(9 - inset, y, 2 + inset, 9 - inset, y, 8 - inset, 'spruce_planks');
    }
    for (const [x, z] of [[3, 2], [9, 2], [3, 8], [9, 8]])
        plan.column(x, z, 1, 7, 'dark_oak_log');
    addDoor(plan, 6, 8, 'spruce_door');
    plan.fill(4, 11, 3, 8, 11, 7, 'dark_oak_planks');
    plan.fill(5, 12, 4, 7, 12, 6, 'dark_oak_planks');
    plan.set(6, 8, 1, 'dark_oak_log');
    plan.fill(1, 8, 1, 11, 8, 1, 'spruce_fence');
    plan.fill(6, 3, 1, 6, 15, 1, 'spruce_fence');
    for (let offset = 2; offset <= 5; offset++) {
        plan.set(6 - offset, 8, 1, 'spruce_planks');
        plan.set(6 + offset, 8, 1, 'spruce_planks');
        plan.set(6, 8 - offset, 1, 'spruce_planks');
        plan.set(6, 8 + offset, 1, 'spruce_planks');
    }
    plan.set(6, 1, 6, 'crafting_table');
    plan.set(8, 1, 6, 'chest');
    return plan;
}

function medievalStoneBridge() {
    const plan = new Blueprint('medieval_stone_bridge', [19, 7, 7], {
        description: 'Kamniti srednjeveski most z oboki, ograjo in svetilkami.',
        category: 'medieval',
        aliases: ['kamniti most', 'most', 'stone bridge'],
    });
    plan.fill(0, 3, 1, 18, 3, 5, 'stone_bricks');
    plan.fill(0, 4, 2, 18, 4, 4, 'cobblestone');
    for (const x of [0, 1, 5, 6, 12, 13, 17, 18])
        plan.fill(x, 0, 1, x, 2, 5, 'stone_bricks');
    for (const x of [2, 3, 4, 7, 8, 9, 10, 11, 14, 15, 16])
        plan.fill(x, 2, 1, x, 2, 5, 'stone_bricks');
    for (let x = 0; x <= 18; x++) {
        plan.set(x, 5, 1, x % 2 === 0 ? 'stone_brick_wall' : 'spruce_fence');
        plan.set(x, 5, 5, x % 2 === 0 ? 'stone_brick_wall' : 'spruce_fence');
    }
    for (const x of [0, 6, 12, 18]) {
        plan.set(x, 6, 1, 'lantern');
        plan.set(x, 6, 5, 'lantern');
    }
    return plan;
}

function medievalKeep() {
    const plan = new Blueprint('medieval_keep', [15, 15, 15], {
        description: 'Velika kamnita utrdba z notranjo dvorano in obrambnim vrhom.',
        category: 'medieval',
        aliases: ['utrdba', 'keep', 'grajski stolp'],
    });
    plan.fill(0, 0, 0, 14, 0, 14, 'stone_bricks');
    for (let y = 1; y <= 10; y++) perimeter(plan, y, y <= 3 ? 'cobblestone' : 'stone_bricks');
    for (const [x, z] of [[0, 0], [14, 0], [0, 14], [14, 14]])
        plan.column(x, z, 1, 12, 'polished_andesite');
    plan.fill(1, 5, 1, 13, 5, 13, 'dark_oak_planks');
    plan.fill(1, 9, 1, 13, 9, 13, 'dark_oak_planks');
    addDoor(plan, 7, 0, 'dark_oak_door');
    for (const y of [3, 7])
        for (const [x, z] of [[3, 0], [11, 0], [3, 14], [11, 14], [0, 3], [0, 11], [14, 3], [14, 11]])
            plan.set(x, y, z, 'iron_bars');
    plan.fill(0, 11, 0, 14, 11, 14, 'stone_bricks');
    perimeter(plan, 12, 'stone_brick_wall');
    for (const [x, z] of [[2, 2], [12, 2], [2, 12], [12, 12]])
        plan.set(x, 12, z, 'lantern');
    plan.set(2, 1, 2, 'crafting_table');
    plan.set(12, 1, 2, 'furnace');
    plan.set(12, 1, 12, 'chest');
    plan.set(7, 6, 7, 'lectern');
    return plan;
}

function modernGlassHouse() {
    const plan = house({
        name: 'modern_glass_house',
        description: 'Odprta moderna hisa z veliko stekla in ravno streho.',
        category: 'modern',
        aliases: ['steklena hisa', 'glass house'],
        width: 11,
        depth: 8,
        wallHeight: 4,
        wall: 'white_concrete',
        frame: 'black_concrete',
        floor: 'smooth_stone',
        glass: 'light_blue_stained_glass',
        door: 'birch_door',
        roof: 'smooth_quartz',
        parapet: 'black_concrete',
        roofType: 'flat',
    });
    plan.fill(1, 2, 7, 9, 3, 7, 'light_blue_stained_glass');
    plan.fill(2, 2, 0, 8, 3, 0, 'light_blue_stained_glass');
    addDoor(plan, 5, 0, 'birch_door');
    return plan;
}

function modernOffice() {
    const plan = new Blueprint('modern_office', [11, 13, 11], {
        description: 'Trinadstropna moderna pisarna s stekleno fasado.',
        category: 'modern',
        aliases: ['pisarna', 'office'],
    });
    plan.fill(0, 0, 0, 10, 0, 10, 'smooth_stone');
    for (let floor = 0; floor < 3; floor++) {
        const baseY = 1 + floor * 4;
        plan.fill(0, baseY, 0, 10, baseY + 2, 0, 'light_blue_stained_glass');
        plan.fill(0, baseY, 10, 10, baseY + 2, 10, 'light_blue_stained_glass');
        plan.fill(0, baseY, 1, 0, baseY + 2, 9, 'white_concrete');
        plan.fill(10, baseY, 1, 10, baseY + 2, 9, 'white_concrete');
        plan.fill(0, baseY + 3, 0, 10, baseY + 3, 10, 'smooth_quartz');
        for (const x of [0, 5, 10]) {
            plan.column(x, 0, baseY, baseY + 3, 'black_concrete');
            plan.column(x, 10, baseY, baseY + 3, 'black_concrete');
        }
    }
    addDoor(plan, 5, 0, 'birch_door');
    return plan;
}

function britishStation() {
    const plan = new Blueprint('british_station', [15, 8, 9], {
        description: 'Majhna britanska zelezniska postaja z nadstreskom.',
        category: 'british',
        aliases: ['postaja', 'train station'],
    });
    plan.fill(0, 0, 0, 14, 0, 8, 'stone_bricks');
    plan.fill(1, 1, 4, 13, 4, 8, 'bricks');
    plan.fill(2, 2, 4, 12, 3, 4, 'white_stained_glass');
    plan.fill(2, 1, 4, 12, 1, 4, 'bricks');
    addDoor(plan, 7, 4, 'dark_oak_door');
    plan.fill(1, 5, 3, 13, 5, 8, 'deepslate_tiles');
    plan.fill(0, 5, 0, 14, 5, 3, 'dark_oak_planks');
    for (const x of [0, 4, 10, 14])
        plan.column(x, 1, 1, 4, 'dark_oak_log');
    plan.fill(1, 1, 1, 5, 1, 1, 'oak_slab');
    plan.fill(9, 1, 1, 13, 1, 1, 'oak_slab');
    return plan;
}

function villageMarket() {
    const plan = new Blueprint('village_market', [15, 7, 13], {
        description: 'Mestna trznica s stirimi pisanimi stojnicami.',
        category: 'civic',
        aliases: ['trznica', 'market'],
    });
    plan.fill(0, 0, 0, 14, 0, 12, 'stone_bricks');
    const stalls = [
        [1, 1, 'red_wool'],
        [9, 1, 'blue_wool'],
        [1, 8, 'yellow_wool'],
        [9, 8, 'green_wool'],
    ];
    for (const [x, z, wool] of stalls) {
        for (const [dx, dz] of [[0, 0], [4, 0], [0, 3], [4, 3]])
            plan.column(x + dx, z + dz, 1, 4, 'oak_log');
        plan.fill(x, 4, z, x + 4, 4, z + 3, wool);
        plan.fill(x + 1, 1, z + 1, x + 3, 1, z + 1, 'oak_planks');
        plan.set(x + 2, 2, z + 2, 'chest');
        plan.set(x + 2, 3, z + 1, 'lantern');
    }
    return plan;
}

function townHall() {
    const plan = house({
        name: 'town_hall',
        description: 'Vecja mestna hisa z dvema nadstropjema in uro.',
        category: 'civic',
        aliases: ['mestna hisa', 'obcina'],
        width: 13,
        depth: 11,
        wallHeight: 8,
        wall: 'stone_bricks',
        frame: 'polished_andesite',
        floor: 'oak_planks',
        glass: 'white_stained_glass',
        door: 'dark_oak_door',
        roof: 'deepslate_tiles',
        roofType: 'gable',
        accent: 'smooth_stone',
    });
    plan.set(6, 6, 0, 'gold_block');
    plan.fill(4, 1, 2, 8, 1, 2, 'oak_planks');
    return plan;
}

function library() {
    const plan = house({
        name: 'library',
        description: 'Kamnita knjiznica z visokimi knjiznimi policami.',
        category: 'civic',
        aliases: ['knjiznica'],
        width: 11,
        depth: 9,
        wallHeight: 6,
        wall: 'stone_bricks',
        frame: 'dark_oak_log',
        floor: 'dark_oak_planks',
        glass: 'orange_stained_glass',
        door: 'dark_oak_door',
        roof: 'dark_oak_planks',
        roofType: 'gable',
    });
    plan.fill(1, 1, 2, 1, 3, 7, 'bookshelf');
    plan.fill(9, 1, 2, 9, 3, 7, 'bookshelf');
    plan.fill(4, 1, 4, 6, 1, 4, 'oak_planks');
    return plan;
}

function warehouse() {
    const plan = house({
        name: 'warehouse',
        description: 'Veliko skladisce z zabojniki in sirokim vhodom.',
        category: 'utility',
        aliases: ['skladisce'],
        width: 13,
        depth: 10,
        wallHeight: 6,
        wall: 'stone_bricks',
        frame: 'stripped_spruce_log',
        floor: 'smooth_stone',
        glass: 'gray_stained_glass',
        door: 'spruce_door',
        roof: 'stone_bricks',
        roofType: 'gable',
    });
    plan.set(6, 1, 0, null);
    plan.set(6, 2, 0, null);
    plan.set(7, 1, 0, 'spruce_door');
    plan.set(7, 2, 0, null);
    for (const [x, z] of [[2, 3], [5, 3], [8, 3], [2, 7], [5, 7], [8, 7]])
        plan.set(x, 1, z, 'barrel');
    return plan;
}

function greenhouse() {
    const plan = new Blueprint('greenhouse', [11, 10, 9], {
        description: 'Steklen rastlinjak z gredami in kompostnikom.',
        category: 'utility',
        aliases: ['rastlinjak'],
    });
    plan.fill(0, 0, 0, 10, 0, 8, 'stone_bricks');
    plan.fill(1, 1, 1, 9, 1, 7, 'dirt');
    for (let y = 1; y <= 4; y++) perimeter(plan, y, 'glass');
    for (const [x, z] of [[0, 0], [10, 0], [0, 8], [10, 8]])
        plan.column(x, z, 1, 5, 'oak_log');
    addDoor(plan, 5, 0, 'oak_door');
    for (let layer = 0; layer < 5; layer++) {
        plan.fill(0, 5 + layer, layer, 10, 5 + layer, layer, 'glass');
        if (8 - layer !== layer)
            plan.fill(0, 5 + layer, 8 - layer, 10, 5 + layer, 8 - layer, 'glass');
    }
    plan.set(1, 1, 1, 'composter');
    return plan;
}

function barn() {
    const plan = house({
        name: 'red_barn',
        description: 'Velik rdec skedenj za kmetijo in zaloge.',
        category: 'utility',
        aliases: ['barn', 'skedenj'],
        width: 13,
        depth: 11,
        wallHeight: 6,
        wall: 'red_terracotta',
        frame: 'stripped_oak_log',
        floor: 'oak_planks',
        glass: 'white_stained_glass',
        door: 'oak_door',
        roof: 'dark_oak_planks',
        roofType: 'gable',
        accent: 'white_concrete',
    });
    for (const [x, z] of [[2, 3], [5, 3], [8, 3], [2, 7], [5, 7], [8, 7]])
        plan.set(x, 1, z, 'hay_block');
    return plan;
}

function fountain() {
    const plan = new Blueprint('stone_fountain', [9, 6, 9], {
        description: 'Okrogla kamnita fontana z modrim srediscem.',
        category: 'decor',
        kind: 'decor',
        aliases: ['fontana'],
    });
    plan.fill(1, 0, 1, 7, 0, 7, 'stone_bricks');
    for (let x = 1; x <= 7; x++)
        for (let z = 1; z <= 7; z++)
            if (x === 1 || x === 7 || z === 1 || z === 7)
                plan.set(x, 1, z, 'stone_bricks');
            else
                plan.set(x, 1, z, 'light_blue_stained_glass');
    plan.column(4, 4, 1, 4, 'chiseled_stone_bricks');
    plan.fill(3, 4, 3, 5, 4, 5, 'stone_bricks');
    plan.set(4, 5, 4, 'sea_lantern');
    return plan;
}

function pavilion() {
    const plan = new Blueprint('garden_pavilion', [9, 8, 9], {
        description: 'Lesen vrtni paviljon za park ali trg.',
        category: 'decor',
        kind: 'decor',
        aliases: ['paviljon', 'gazebo'],
    });
    plan.fill(1, 0, 1, 7, 0, 7, 'stone_bricks');
    for (const [x, z] of [[1, 1], [7, 1], [1, 7], [7, 7]])
        plan.column(x, z, 1, 5, 'oak_log');
    plan.fill(1, 5, 1, 7, 5, 7, 'oak_planks');
    plan.fill(2, 6, 2, 6, 6, 6, 'dark_oak_planks');
    plan.fill(3, 7, 3, 5, 7, 5, 'dark_oak_planks');
    plan.set(4, 4, 4, 'lantern');
    return plan;
}

function lampPost() {
    const plan = new Blueprint('lamp_post', [3, 7, 3], {
        description: 'Kamnita ulicna svetilka.',
        category: 'decor',
        kind: 'decor',
        aliases: ['svetilka', 'luc'],
    });
    plan.fill(0, 0, 0, 2, 0, 2, 'stone_bricks');
    plan.column(1, 1, 1, 5, 'polished_blackstone_brick_wall');
    plan.fill(0, 5, 1, 2, 5, 1, 'polished_blackstone_bricks');
    plan.set(0, 4, 1, 'lantern');
    plan.set(2, 4, 1, 'lantern');
    plan.set(1, 6, 1, 'stone_brick_slab');
    return plan;
}

function parkBench() {
    const plan = new Blueprint('park_bench', [7, 4, 3], {
        description: 'Preprosta lesena klop za park.',
        category: 'decor',
        kind: 'decor',
        aliases: ['klop'],
    });
    plan.fill(0, 0, 0, 6, 0, 2, 'grass_block');
    plan.set(1, 1, 1, 'oak_log');
    plan.set(5, 1, 1, 'oak_log');
    plan.fill(1, 2, 1, 5, 2, 1, 'oak_slab');
    plan.fill(1, 3, 2, 5, 3, 2, 'oak_slab');
    return plan;
}

function flowerGarden() {
    const plan = new Blueprint('flower_garden', [11, 4, 9], {
        description: 'Urejen cvetlicni vrt z zivo mejo in potjo.',
        category: 'decor',
        kind: 'decor',
        aliases: ['vrt', 'garden'],
    });
    plan.fill(0, 0, 0, 10, 0, 8, 'grass_block');
    for (let x = 0; x <= 10; x++) {
        plan.set(x, 1, 0, 'oak_leaves');
        plan.set(x, 1, 8, 'oak_leaves');
    }
    for (let z = 1; z < 8; z++) {
        plan.set(0, 1, z, 'oak_leaves');
        plan.set(10, 1, z, 'oak_leaves');
    }
    plan.fill(5, 1, 0, 5, 1, 8, 'gravel');
    const flowers = ['poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet'];
    let index = 0;
    for (const x of [2, 3, 7, 8])
        for (const z of [2, 4, 6])
            plan.set(x, 1, z, flowers[index++ % flowers.length]);
    return plan;
}

function grassBase(plan, block = 'grass_block') {
    const [width, , depth] = plan.size;
    plan.fill(0, 0, 0, width - 1, 0, depth - 1, block);
}

function oakLanternPost() {
    const plan = new Blueprint('oak_lantern_post', [3, 6, 3], {
        description: 'Topla lesena ulicna svetilka za ozke vaske poti.',
        category: 'decor',
        kind: 'decor',
        aliases: ['lesena svetilka', 'oak lamp'],
    });
    grassBase(plan);
    plan.fill(0, 0, 1, 2, 0, 1, 'coarse_dirt');
    plan.set(1, 1, 1, 'cobblestone_wall');
    plan.column(1, 1, 2, 4, 'oak_fence');
    plan.set(1, 5, 1, 'lantern');
    return plan;
}

function spruceLanternArch() {
    const plan = new Blueprint('spruce_lantern_arch', [5, 6, 3], {
        description: 'Majhen smrekov lok z lucjo nad potjo.',
        category: 'decor',
        kind: 'decor',
        aliases: ['lucni lok', 'arch lamp'],
    });
    grassBase(plan);
    plan.fill(0, 0, 1, 4, 0, 1, 'gravel');
    plan.column(1, 1, 1, 4, 'spruce_fence');
    plan.column(3, 1, 1, 4, 'spruce_fence');
    plan.fill(1, 5, 1, 3, 5, 1, 'spruce_log');
    plan.set(2, 4, 1, 'sea_lantern');
    return plan;
}

function stoneLanternPillar() {
    const plan = new Blueprint('stone_lantern_pillar', [3, 5, 3], {
        description: 'Nizka kamnita svetilka za krizisca in trge.',
        category: 'decor',
        kind: 'decor',
        aliases: ['kamnita luc', 'stone lamp'],
    });
    grassBase(plan);
    plan.fill(0, 0, 0, 2, 0, 2, 'stone_bricks');
    plan.set(1, 1, 1, 'stone_brick_wall');
    plan.set(1, 2, 1, 'stone_brick_wall');
    plan.set(1, 3, 1, 'sea_lantern');
    plan.set(1, 4, 1, 'stone_brick_slab');
    return plan;
}

function marketAwning() {
    const plan = new Blueprint('market_awning', [7, 5, 5], {
        description: 'Majhna pisana trzna stojnica z zabojem in sodom.',
        category: 'decor',
        kind: 'decor',
        aliases: ['stojnica', 'awning'],
    });
    grassBase(plan, 'dirt_path');
    for (const [x, z] of [[1, 1], [5, 1], [1, 3], [5, 3]])
        plan.column(x, z, 1, 3, 'oak_fence');
    for (let x = 0; x <= 6; x++)
        for (let z = 0; z <= 4; z++)
            if (z !== 0 || x % 2 === 0)
                plan.set(x, 4, z, (x + z) % 2 === 0 ? 'red_wool' : 'white_wool');
    plan.fill(2, 1, 2, 4, 1, 2, 'oak_planks');
    plan.set(2, 2, 3, 'barrel');
    plan.set(4, 2, 3, 'barrel');
    return plan;
}

function noticeBoard() {
    const plan = new Blueprint('notice_board', [5, 4, 3], {
        description: 'Vaska oglasna tabla z lesenim podstavkom.',
        category: 'decor',
        kind: 'decor',
        aliases: ['oglasna tabla', 'tabla'],
    });
    grassBase(plan);
    plan.fill(1, 0, 1, 3, 0, 1, 'coarse_dirt');
    plan.column(1, 1, 1, 3, 'spruce_fence');
    plan.column(3, 1, 1, 3, 'spruce_fence');
    plan.fill(1, 2, 0, 3, 3, 0, 'spruce_planks');
    plan.set(2, 3, 1, 'lantern');
    return plan;
}

function crateStack() {
    const plan = new Blueprint('crate_stack', [5, 4, 4], {
        description: 'Neurejen kup zabojev za ob delavnicah in trznici.',
        category: 'decor',
        kind: 'decor',
        aliases: ['zaboji', 'crates'],
    });
    grassBase(plan);
    plan.set(1, 1, 1, 'oak_planks');
    plan.set(2, 1, 1, 'spruce_planks');
    plan.set(3, 1, 1, 'barrel');
    plan.set(1, 1, 2, 'barrel');
    plan.set(2, 1, 2, 'oak_planks');
    plan.set(3, 1, 2, 'spruce_planks');
    plan.set(2, 2, 1, 'barrel');
    plan.set(3, 2, 2, 'oak_planks');
    plan.set(2, 3, 2, 'spruce_planks');
    return plan;
}

function barrelStack() {
    const plan = new Blueprint('barrel_stack', [4, 4, 4], {
        description: 'Sodi ob gostilni ali skladiscu.',
        category: 'decor',
        kind: 'decor',
        aliases: ['sodi', 'barrels'],
    });
    grassBase(plan);
    for (const [x, z] of [[1, 1], [2, 1], [1, 2], [2, 2]])
        plan.set(x, 1, z, 'barrel');
    plan.set(1, 2, 1, 'barrel');
    plan.set(2, 2, 2, 'barrel');
    plan.set(1, 3, 2, 'lantern');
    return plan;
}

function woodpile() {
    const plan = new Blueprint('woodpile', [7, 3, 4], {
        description: 'Zlozen kup hlodov za kovacijo ali pekarno.',
        category: 'decor',
        kind: 'decor',
        aliases: ['drva', 'wood pile'],
    });
    grassBase(plan);
    plan.fill(1, 1, 1, 5, 1, 1, 'oak_log');
    plan.fill(1, 1, 2, 5, 1, 2, 'spruce_log');
    plan.fill(2, 2, 1, 4, 2, 1, 'dark_oak_log');
    plan.fill(2, 2, 2, 4, 2, 2, 'oak_log');
    plan.set(0, 1, 1, 'spruce_fence');
    plan.set(6, 1, 1, 'spruce_fence');
    plan.set(0, 1, 2, 'spruce_fence');
    plan.set(6, 1, 2, 'spruce_fence');
    return plan;
}

function hayCart() {
    const plan = new Blueprint('hay_cart', [7, 4, 5], {
        description: 'Mali voz sena kot v vaski kmetiji.',
        category: 'decor',
        kind: 'decor',
        aliases: ['voz sena', 'cart'],
    });
    grassBase(plan);
    plan.fill(1, 1, 1, 5, 1, 3, 'oak_slab');
    plan.fill(2, 2, 1, 4, 2, 3, 'hay_block');
    for (const [x, z] of [[1, 0], [5, 0], [1, 4], [5, 4]])
        plan.set(x, 1, z, 'blackstone');
    plan.fill(0, 2, 2, 1, 2, 2, 'oak_fence');
    plan.fill(5, 2, 2, 6, 2, 2, 'oak_fence');
    return plan;
}

function waterTrough() {
    const plan = new Blueprint('water_trough', [5, 3, 3], {
        description: 'Leseno korito z modrim vodnim srediscem.',
        category: 'decor',
        kind: 'decor',
        aliases: ['korito', 'trough'],
    });
    grassBase(plan);
    plan.fill(0, 1, 0, 4, 1, 2, 'spruce_planks');
    plan.fill(1, 2, 1, 3, 2, 1, 'light_blue_stained_glass');
    plan.set(0, 2, 0, 'spruce_slab');
    plan.set(4, 2, 0, 'spruce_slab');
    plan.set(0, 2, 2, 'spruce_slab');
    plan.set(4, 2, 2, 'spruce_slab');
    return plan;
}

function villageWell() {
    const plan = new Blueprint('village_well', [7, 8, 7], {
        description: 'Kompakten vaski vodnjak s streho in kamnitim robom.',
        category: 'decor',
        kind: 'decor',
        aliases: ['vodnjak', 'well'],
    });
    grassBase(plan);
    plan.fill(1, 0, 1, 5, 0, 5, 'cobblestone');
    plan.fill(1, 1, 1, 5, 1, 5, 'cobblestone_wall');
    plan.fill(2, 1, 2, 4, 1, 4, 'light_blue_stained_glass');
    for (const [x, z] of [[1, 1], [5, 1], [1, 5], [5, 5]])
        plan.column(x, z, 2, 5, 'oak_log');
    plan.fill(1, 6, 1, 5, 6, 5, 'spruce_planks');
    plan.fill(2, 7, 2, 4, 7, 4, 'dark_oak_planks');
    plan.set(3, 4, 3, 'chain');
    plan.set(3, 3, 3, 'lantern');
    return plan;
}

function campfireCircle() {
    const plan = new Blueprint('campfire_circle', [7, 3, 7], {
        description: 'Krozisce ob tabornem ognju s hlodi za sedenje.',
        category: 'decor',
        kind: 'decor',
        aliases: ['ogenj', 'campfire'],
    });
    grassBase(plan);
    for (const [x, z] of [[2, 1], [3, 1], [4, 1], [1, 2], [5, 2], [1, 3], [5, 3], [1, 4], [5, 4], [2, 5], [3, 5], [4, 5]])
        plan.set(x, 1, z, 'cobblestone');
    plan.set(3, 1, 3, 'campfire');
    plan.fill(0, 1, 2, 0, 1, 4, 'oak_log');
    plan.fill(6, 1, 2, 6, 1, 4, 'oak_log');
    plan.fill(2, 1, 0, 4, 1, 0, 'spruce_log');
    plan.fill(2, 1, 6, 4, 1, 6, 'spruce_log');
    return plan;
}

function picnicTable() {
    const plan = new Blueprint('picnic_table', [7, 4, 5], {
        description: 'Piknik miza s klopema in majhno senco.',
        category: 'decor',
        kind: 'decor',
        aliases: ['piknik', 'picnic'],
    });
    grassBase(plan);
    plan.set(2, 1, 2, 'oak_fence');
    plan.set(4, 1, 2, 'oak_fence');
    plan.fill(2, 2, 2, 4, 2, 2, 'oak_slab');
    plan.fill(1, 1, 1, 5, 1, 1, 'spruce_slab');
    plan.fill(1, 1, 3, 5, 1, 3, 'spruce_slab');
    plan.column(3, 2, 1, 3, 'oak_fence');
    plan.fill(2, 3, 1, 4, 3, 3, 'yellow_wool');
    return plan;
}

function flowerPlanterBoxes() {
    const plan = new Blueprint('flower_planter_boxes', [7, 4, 5], {
        description: 'Lesena korita z razlicnimi cvetlicami.',
        category: 'decor',
        kind: 'decor',
        aliases: ['korita roz', 'planter'],
    });
    grassBase(plan);
    for (const z of [1, 3]) {
        plan.fill(1, 1, z, 5, 1, z, 'spruce_planks');
        plan.fill(2, 2, z, 4, 2, z, 'dirt');
    }
    const flowers = ['poppy', 'dandelion', 'allium', 'azure_bluet', 'blue_orchid', 'orange_tulip'];
    let index = 0;
    for (const z of [1, 3])
        for (const x of [2, 3, 4])
            plan.set(x, 3, z, flowers[index++ % flowers.length]);
    return plan;
}

function hedgeCorner() {
    const plan = new Blueprint('hedge_corner', [5, 3, 5], {
        description: 'Urejen vogal iz zive meje in poti.',
        category: 'decor',
        kind: 'decor',
        aliases: ['ziva meja', 'hedge'],
    });
    grassBase(plan);
    plan.fill(0, 1, 0, 4, 1, 0, 'oak_leaves');
    plan.fill(0, 1, 0, 0, 1, 4, 'oak_leaves');
    plan.set(0, 2, 0, 'lantern');
    plan.fill(1, 0, 1, 4, 0, 4, 'gravel');
    return plan;
}

function hedgeArch() {
    const plan = new Blueprint('hedge_arch', [7, 5, 3], {
        description: 'Vrtni lok iz listja nad prodnato potjo.',
        category: 'decor',
        kind: 'decor',
        aliases: ['vrtni lok', 'garden arch'],
    });
    grassBase(plan);
    plan.fill(0, 0, 1, 6, 0, 1, 'gravel');
    plan.column(1, 0, 1, 3, 'oak_leaves');
    plan.column(1, 2, 1, 3, 'oak_leaves');
    plan.column(5, 0, 1, 3, 'oak_leaves');
    plan.column(5, 2, 1, 3, 'oak_leaves');
    plan.fill(1, 4, 0, 5, 4, 2, 'oak_leaves');
    plan.set(3, 3, 1, 'lantern');
    return plan;
}

function scarecrow() {
    const plan = new Blueprint('scarecrow', [5, 6, 5], {
        description: 'Strasilo za rob polja ali vrt.',
        category: 'decor',
        kind: 'decor',
        aliases: ['strasilo', 'scarecrow'],
    });
    grassBase(plan, 'farmland');
    plan.column(2, 2, 1, 3, 'oak_fence');
    plan.fill(0, 3, 2, 4, 3, 2, 'oak_fence');
    plan.set(2, 4, 2, 'hay_block');
    plan.set(2, 5, 2, 'carved_pumpkin');
    plan.set(1, 2, 1, 'wheat');
    plan.set(3, 2, 1, 'wheat');
    plan.set(1, 2, 3, 'carrots');
    plan.set(3, 2, 3, 'potatoes');
    return plan;
}

function cropPatchSmall() {
    const plan = new Blueprint('crop_patch_small', [9, 3, 7], {
        description: 'Majhna obcestna greda s pridelki in ograjo.',
        category: 'decor',
        kind: 'decor',
        aliases: ['greda', 'crop patch'],
    });
    grassBase(plan, 'farmland');
    for (let x = 0; x <= 8; x++) {
        plan.set(x, 1, 0, 'spruce_fence');
        plan.set(x, 1, 6, 'spruce_fence');
    }
    for (let z = 1; z <= 5; z++) {
        plan.set(0, 1, z, 'spruce_fence');
        plan.set(8, 1, z, 'spruce_fence');
    }
    plan.fill(4, 1, 1, 4, 1, 5, 'light_blue_stained_glass');
    const crops = ['wheat', 'carrots', 'potatoes'];
    for (const x of [2, 3, 5, 6])
        for (const z of [1, 2, 4, 5])
            plan.set(x, 1, z, crops[(x + z) % crops.length]);
    return plan;
}

function stoneBench() {
    const plan = new Blueprint('stone_bench', [7, 3, 3], {
        description: 'Robustna kamnita klop za trg ali obzidje.',
        category: 'decor',
        kind: 'decor',
        aliases: ['kamnita klop', 'stone bench'],
    });
    grassBase(plan);
    plan.fill(0, 0, 1, 6, 0, 1, 'stone_bricks');
    plan.set(1, 1, 1, 'stone_brick_wall');
    plan.set(5, 1, 1, 'stone_brick_wall');
    plan.fill(1, 2, 1, 5, 2, 1, 'stone_slab');
    plan.fill(1, 2, 2, 5, 2, 2, 'stone_slab');
    return plan;
}

function waysideShrine() {
    const plan = new Blueprint('wayside_shrine', [5, 6, 5], {
        description: 'Majhno kamnito znamenje z lucjo ob poti.',
        category: 'decor',
        kind: 'decor',
        aliases: ['znamenje', 'shrine'],
    });
    grassBase(plan);
    plan.fill(1, 0, 1, 3, 0, 3, 'mossy_cobblestone');
    plan.fill(1, 1, 1, 3, 1, 3, 'stone_bricks');
    plan.set(2, 2, 1, 'stone_brick_wall');
    plan.set(2, 2, 3, 'stone_brick_wall');
    plan.column(2, 2, 2, 4, 'chiseled_stone_bricks');
    plan.set(2, 3, 1, 'lantern');
    plan.set(2, 5, 2, 'stone_brick_slab');
    return plan;
}

const plans = [
    house({
        name: 'medieval_cottage',
        description: 'Majhna srednjeveska koca iz kamna in temnega lesa.',
        category: 'medieval',
        aliases: ['srednjeveska koca'],
        width: 9, depth: 8, wallHeight: 5,
        wall: 'cobblestone', frame: 'dark_oak_log', floor: 'spruce_planks',
        glass: 'glass', door: 'spruce_door', roof: 'dark_oak_planks',
        roofType: 'gable', chimney: 'bricks',
    }),
    house({
        name: 'medieval_tavern',
        description: 'Dvonadstropna srednjeveska gostilna z veliko dvorano.',
        category: 'medieval',
        aliases: ['taverna', 'gostilna'],
        width: 13, depth: 10, wallHeight: 8,
        wall: 'spruce_planks', frame: 'dark_oak_log', floor: 'oak_planks',
        glass: 'yellow_stained_glass', door: 'dark_oak_door', roof: 'deepslate_tiles',
        roofType: 'gable', chimney: 'bricks', accent: 'cobblestone',
    }),
    house({
        name: 'medieval_blacksmith',
        description: 'Srednjeveska kovacija s pecmi, nakovalom in delavnico.',
        category: 'medieval',
        aliases: ['kovacija', 'blacksmith'],
        width: 10, depth: 9, wallHeight: 5,
        wall: 'stone_bricks', frame: 'spruce_log', floor: 'cobblestone',
        glass: 'iron_bars', door: 'spruce_door', roof: 'spruce_planks',
        roofType: 'gable', chimney: 'bricks',
    }),
    medievalWatchtower(),
    medievalChapel(),
    house({
        name: 'medieval_manor',
        description: 'Velika srednjeveska grascina z dvema nadstropjema in kamnitim podstavkom.',
        category: 'medieval',
        aliases: ['grascina', 'manor', 'plemiska hisa'],
        width: 15, depth: 12, wallHeight: 8,
        wall: 'white_terracotta', frame: 'dark_oak_log', floor: 'dark_oak_planks',
        glass: 'yellow_stained_glass', door: 'dark_oak_door', roof: 'deepslate_tiles',
        roofType: 'gable', chimney: 'bricks', accent: 'stone_bricks',
    }),
    house({
        name: 'medieval_bakery',
        description: 'Topla srednjeveska pekarna z veliko opecnato pecjo.',
        category: 'medieval',
        aliases: ['pekarna', 'bakery'],
        width: 9, depth: 9, wallHeight: 5,
        wall: 'bricks', frame: 'spruce_log', floor: 'cobblestone',
        glass: 'orange_stained_glass', door: 'spruce_door', roof: 'spruce_planks',
        roofType: 'gable', chimney: 'bricks', accent: 'smooth_stone',
    }),
    house({
        name: 'medieval_barracks',
        description: 'Dolga srednjeveska vojasnica za mestno strazo.',
        category: 'medieval',
        aliases: ['vojasnica', 'barracks', 'kasarna'],
        width: 15, depth: 10, wallHeight: 6,
        wall: 'stone_bricks', frame: 'dark_oak_log', floor: 'spruce_planks',
        glass: 'iron_bars', door: 'dark_oak_door', roof: 'dark_oak_planks',
        roofType: 'gable', chimney: 'cobblestone', accent: 'polished_andesite',
    }),
    house({
        name: 'medieval_guildhall',
        description: 'Velika cehovska dvorana za sestanke, trgovino in praznovanja.',
        category: 'medieval',
        aliases: ['cehovska dvorana', 'guildhall', 'ceh'],
        width: 15, depth: 12, wallHeight: 8,
        wall: 'spruce_planks', frame: 'stripped_dark_oak_log', floor: 'oak_planks',
        glass: 'red_stained_glass', door: 'dark_oak_door', roof: 'deepslate_tiles',
        roofType: 'gable', chimney: 'bricks', accent: 'stone_bricks',
    }),
    house({
        name: 'medieval_apothecary',
        description: 'Majhna srednjeveska apoteka za napoje in zdravilna zelisca.',
        category: 'medieval',
        aliases: ['apoteka', 'apothecary', 'zdravilec'],
        width: 9, depth: 8, wallHeight: 5,
        wall: 'mossy_cobblestone', frame: 'dark_oak_log', floor: 'spruce_planks',
        glass: 'lime_stained_glass', door: 'dark_oak_door', roof: 'dark_oak_planks',
        roofType: 'gable', chimney: 'bricks', accent: 'spruce_planks',
    }),
    medievalStable(),
    medievalGatehouse(),
    medievalWindmill(),
    medievalStoneBridge(),
    medievalKeep(),
    house({
        name: 'modern_villa',
        description: 'Prostorna moderna vila z belo fasado in ravno streho.',
        category: 'modern',
        aliases: ['moderna vila', 'villa'],
        width: 13, depth: 10, wallHeight: 6,
        wall: 'white_concrete', frame: 'gray_concrete', floor: 'smooth_quartz',
        glass: 'light_blue_stained_glass', door: 'birch_door', roof: 'smooth_quartz',
        roofType: 'flat', parapet: 'gray_concrete', accent: 'black_concrete',
    }),
    house({
        name: 'modern_townhouse',
        description: 'Ozka dvonadstropna moderna mestna hisa.',
        category: 'modern',
        aliases: ['moderna mestna hisa'],
        width: 8, depth: 10, wallHeight: 8,
        wall: 'light_gray_concrete', frame: 'black_concrete', floor: 'birch_planks',
        glass: 'light_blue_stained_glass', door: 'birch_door', roof: 'smooth_stone',
        roofType: 'flat', parapet: 'black_concrete',
    }),
    modernGlassHouse(),
    modernOffice(),
    house({
        name: 'british_cottage',
        description: 'Prijetna britanska podezelska hisa iz opeke.',
        category: 'british',
        aliases: ['britanska koca'],
        width: 9, depth: 8, wallHeight: 5,
        wall: 'bricks', frame: 'white_concrete', floor: 'oak_planks',
        glass: 'white_stained_glass', door: 'dark_oak_door', roof: 'deepslate_tiles',
        roofType: 'gable', chimney: 'bricks',
    }),
    house({
        name: 'british_townhouse',
        description: 'Visoka britanska vrstna hisa iz rdece opeke.',
        category: 'british',
        aliases: ['britanska vrstna hisa'],
        width: 8, depth: 10, wallHeight: 8,
        wall: 'bricks', frame: 'smooth_stone', floor: 'dark_oak_planks',
        glass: 'white_stained_glass', door: 'dark_oak_door', roof: 'deepslate_tiles',
        roofType: 'gable', chimney: 'bricks', accent: 'white_concrete',
    }),
    house({
        name: 'british_pub',
        description: 'Tradicionalen britanski pub s temnim lesom in toplimi okni.',
        category: 'british',
        aliases: ['pub', 'pivnica'],
        width: 12, depth: 9, wallHeight: 6,
        wall: 'bricks', frame: 'dark_oak_log', floor: 'dark_oak_planks',
        glass: 'orange_stained_glass', door: 'dark_oak_door', roof: 'dark_oak_planks',
        roofType: 'gable', chimney: 'bricks', accent: 'white_concrete',
    }),
    britishStation(),
    villageMarket(),
    townHall(),
    library(),
    warehouse(),
    greenhouse(),
    barn(),
    fountain(),
    pavilion(),
    lampPost(),
    parkBench(),
    flowerGarden(),
    oakLanternPost(),
    spruceLanternArch(),
    stoneLanternPillar(),
    marketAwning(),
    noticeBoard(),
    crateStack(),
    barrelStack(),
    woodpile(),
    hayCart(),
    waterTrough(),
    villageWell(),
    campfireCircle(),
    picnicTable(),
    flowerPlanterBoxes(),
    hedgeCorner(),
    hedgeArch(),
    scarecrow(),
    cropPatchSmall(),
    stoneBench(),
    waysideShrine(),
];

const summary = [];
for (const plan of plans) {
    const count = plan.save();
    if (count > 3000) throw new Error(`${plan.name} is too large: ${count} blocks`);
    summary.push(`${plan.name}:${count}`);
}

console.log(`Generated ${plans.length} schematics.`);
console.log(summary.join('\n'));
