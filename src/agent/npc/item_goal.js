import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { itemSatisfied } from './utils.js';


const blacklist = [
    'coal_block',
    'iron_block',
    'gold_block',
    'diamond_block',
    'deepslate',
    'blackstone',
    'netherite',
    '_wood',
    'stripped_',
    'crimson',
    'warped',
    'dye'
];

export function scaleRecipeRequirements(recipe, craftedCount = 1, quantity = 1) {
    const batches = Math.max(1, Math.ceil(
        Math.max(1, Number(quantity) || 1) / Math.max(1, Number(craftedCount) || 1),
    ));
    return Object.entries(recipe ?? {}).map(([name, amount]) => ({
        name,
        quantity: Math.max(1, Number(amount) || 1) * batches,
    }));
}


class ItemNode {
    constructor(manager, wrapper, name) {
        this.manager = manager;
        this.wrapper = wrapper;
        this.name = name;
        this.type = '';
        this.source = null;
        this.prereq = null;
        this.recipe = [];
        this.craftedCount = 1;
        this.fails = 0;
        this.lastFailureAt = 0;
    }

    setRecipe(recipe, craftedCount = 1, requiresTable = false) {
        this.type = 'craft';
        this.craftedCount = Math.max(1, Number(craftedCount) || 1);
        this.recipe = [];
        for (let [key, value] of Object.entries(recipe)) {
            if (this.manager.nodes[key] === undefined)
                this.manager.nodes[key] = new ItemWrapper(this.manager, this.wrapper, key);
            this.recipe.push({node: this.manager.nodes[key], quantity: value});
        }
        if (requiresTable) {
            if (this.manager.nodes['crafting_table'] === undefined)
                this.manager.nodes['crafting_table'] = new ItemWrapper(this.manager, this.wrapper, 'crafting_table');
            this.prereq = this.manager.nodes['crafting_table'];
        }
        return this;
    }

    setCollectable(source=null, tool=null) {
        this.type = 'block';
        if (source)
            this.source = source;
        else
            this.source = this.name;
        if (tool) {
            if (this.manager.nodes[tool] === undefined)
                this.manager.nodes[tool] = new ItemWrapper(this.manager, this.wrapper, tool);
            this.prereq = this.manager.nodes[tool];
        }
        return this;
    }

    setSmeltable(source_item) {
        this.type = 'smelt';
        if (this.manager.nodes['furnace'] === undefined)
            this.manager.nodes['furnace'] = new ItemWrapper(this.manager, this.wrapper, 'furnace');
        this.prereq = this.manager.nodes['furnace'];

        if (this.manager.nodes[source_item] === undefined)
            this.manager.nodes[source_item] = new ItemWrapper(this.manager, this.wrapper, source_item);
        if (this.manager.nodes['coal'] === undefined)
            this.manager.nodes['coal'] = new ItemWrapper(this.manager, this.wrapper, 'coal');
        this.recipe = [
            {node: this.manager.nodes[source_item], quantity: 1},
            {node: this.manager.nodes['coal'], quantity: 1}
        ];
        return this;
    }

    setHuntable(animal_source) {
        this.type = 'hunt';
        this.source = animal_source;
        return this;
    }

    getChildren(quantity = 1) {
        let children;
        if (this.type === 'craft') {
            const batches = Math.max(1, Math.ceil(quantity / this.craftedCount));
            children = this.recipe.map(child => ({
                node: child.node,
                quantity: child.quantity * batches,
            }));
        } else if (this.type === 'smelt') {
            children = [
                { node: this.recipe[0].node, quantity },
                { node: this.recipe[1].node, quantity: Math.max(1, Math.ceil(quantity / 8)) },
            ];
        } else {
            children = [...this.recipe];
        }
        if (this.prereq) {
            children.push({node: this.prereq, quantity: 1});
        }
        return children;
    }

    isReady(quantity = 1) {
        for (let child of this.getChildren(quantity)) {
            if (!child.node.isDone(child.quantity)) {
                return false;
            }
        }
        return true;
    }

    isDone(quantity=1) {
        if (this.manager.goal.name === this.name)
            return false;
        return itemSatisfied(this.manager.agent.bot, this.name, quantity);
    }

    getDepth(q=1) {
        if (this.isDone(q)) {
            return 0;
        }
        let depth = this.executionCost(q);
        for (let child of this.getChildren(q)) {
            depth += child.node.getDepth(child.quantity);
        }
        return depth + 1;
    }

    executionCost(quantity = 1) {
        const q = Math.max(1, Number(quantity) || 1);
        if (this.type === 'craft') return Math.max(1, Math.ceil(q / this.craftedCount)) * 0.1;
        if (this.type === 'smelt') return q * 0.15 + 1;
        if (this.type === 'hunt') {
            const absent = this.manager.context?.nearbyEntities
                && !this.manager.context.nearbyEntities.has(this.source);
            return q * 0.8 + 4 + (absent ? 22 : 0);
        }
        if (this.type === 'block') {
            const absent = this.manager.context?.nearbyBlocks
                && !this.manager.context.nearbyBlocks.has(this.source);
            return q * 0.35 + 2 + (absent ? 18 : 0);
        }
        return q;
    }

    getFails(q=1) {
        if (this.isDone(q)) {
            return 0;
        }
        let fails = this.failurePenalty();
        for (let child of this.getChildren(q)) {
            fails += child.node.getFails(child.quantity);
        }
        return fails;
    }

    getNext(q=1) {
        if (this.isDone(q))
            return null;
        if (this.isReady(q))
            return {node: this, quantity: q};
        for (let child of this.getChildren(q)) {
            let res = child.node.getNext(child.quantity);
            if (res)
                return res;
        }
        return null;
    }

    async execute(quantity=1) {
        if (!this.isReady(quantity)) {
            this.recordFailure();
            return;
        }
        let inventory = world.getInventoryCounts(this.manager.agent.bot);
        let init_quantity = inventory[this.name] || 0;
        if (this.type === 'block') {
            await skills.collectBlock(this.manager.agent.bot, this.source, quantity, this.manager.agent.npc.getBuiltPositions());
        } else if (this.type === 'smelt') {
            let to_smelt_name = this.recipe[0].node.name;
            let to_smelt_quantity = Math.min(quantity, inventory[to_smelt_name] || 1);
            await skills.smeltItem(this.manager.agent.bot, to_smelt_name, to_smelt_quantity);
        } else if (this.type === 'hunt') {
            for (let i=0; i<quantity; i++) {
                const res = await skills.attackNearest(this.manager.agent.bot, this.source);
                if (!res || this.manager.agent.bot.interrupt_code)
                    break;
            }
        } else if (this.type === 'craft') {
            await skills.craftRecipe(this.manager.agent.bot, this.name, quantity);
        }
        let final_quantity = world.getInventoryCounts(this.manager.agent.bot)[this.name] || 0;
        if (final_quantity <= init_quantity) {
            this.recordFailure();
        }
    }

    recordFailure() {
        this.fails += 1;
        this.lastFailureAt = Date.now();
    }

    failurePenalty(now = Date.now()) {
        if (!this.lastFailureAt || this.fails <= 0) return 0;
        const decay = Math.max(0, 1 - (now - this.lastFailureAt) / (10 * 60_000));
        return Math.min(40, this.fails * 6) * decay;
    }
}


class ItemWrapper {
    constructor(manager, parent, name) {
        this.manager = manager;
        this.name = name;
        this.parent = parent;
        this.methods = [];

        let blacklisted = false;
        for (let match of blacklist) {
            if (name.includes(match)) {
                blacklisted = true;
                break;
            }
        }

        if (!blacklisted && !this.containsCircularDependency()) {
            this.createChildren();
        }
    }

    add_method(method) {
        for (let child of method.getChildren(1)) {
            if (child.node.methods.length === 0)
                return;
        }
        this.methods.push(method);
    }

    createChildren() {
        let recipes = mc.getItemCraftingRecipes(this.name) ?? [];
        if (recipes) {
            for (let [recipe, metadata] of recipes) {
                let includes_blacklisted = false;
                for (let ingredient in recipe) {
                    for (let match of blacklist) {
                        if (ingredient.includes(match)) {
                            includes_blacklisted = true;
                            break;
                        }
                    }
                    if (includes_blacklisted) break;
                }
                if (includes_blacklisted) continue;
                this.add_method(new ItemNode(this.manager, this, this.name).setRecipe(
                    recipe,
                    metadata?.craftedCount ?? 1,
                    metadata?.requiresTable === true,
                ));
            }
        }

        let block_sources = mc.getItemBlockSources(this.name);
        if (block_sources.length > 0 && this.name !== 'torch' && !this.name.includes('bed')) {  // Do not collect placed torches or beds
            for (let block_source of block_sources) {
                if (block_source === 'grass_block' || block_source === 'grass') continue;  // Dirt nodes will collect grass blocks
                let tool = mc.getBlockTool(block_source);
                this.add_method(new ItemNode(this.manager, this, this.name).setCollectable(block_source, tool));
            }
        }

        let smeltingIngredient = mc.getItemSmeltingIngredient(this.name);
        if (smeltingIngredient) {
            this.add_method(new ItemNode(this.manager, this, this.name).setSmeltable(smeltingIngredient));
        }

        let animal_source = mc.getItemAnimalSource(this.name);
        if (animal_source) {
            this.add_method(new ItemNode(this.manager, this, this.name).setHuntable(animal_source));
        }
    }

    containsCircularDependency() {
        let p = this.parent;
        while (p) {
            if (p.name === this.name) {
                return true;
            }
            p = p.parent;
        }
        return false;
    }

    getBestMethod(q=1) {
        const cacheKey = `${this.name}:${Math.max(1, Number(q) || 1)}`;
        const cached = this.manager.context?.methodCache?.get(cacheKey);
        if (cached) return cached;
        let best_cost = -1;
        let best_method = null;
        for (let method of this.methods) {
            let cost = method.getDepth(q) + method.getFails(q);
            if (best_cost == -1 || cost < best_cost) {
                best_cost = cost;
                best_method = method;
            }
        }
        if (best_method) this.manager.context?.methodCache?.set(cacheKey, best_method);
        return best_method;
    }

    isDone(q=1) {
        if (this.methods.length === 0)
            return false;
        return this.getBestMethod(q).isDone(q);
    }

    getDepth(q=1) {
        if (this.methods.length === 0)
            return 0;
        return this.getBestMethod(q).getDepth(q);
    }

    getFails(q=1) {
        if (this.methods.length === 0)
            return 0;
        return this.getBestMethod(q).getFails(q);
    }

    getNext(q=1) {
        if (this.methods.length === 0)
            return null;
        return this.getBestMethod(q).getNext(q);
    }
}


export class ItemGoal {
    constructor(agent) {
        this.agent = agent;
        this.goal = null;
        this.nodes = {};
        this.failed = [];
        this.context = null;
    }

    refreshContext() {
        let nearbyBlocks = [];
        let nearbyEntities = [];
        try { nearbyBlocks = world.getNearbyBlockTypes(this.agent.bot); } catch { /* incomplete test/world */ }
        try { nearbyEntities = world.getNearbyEntityTypes(this.agent.bot); } catch { /* incomplete test/world */ }
        this.context = {
            nearbyBlocks: new Set(nearbyBlocks),
            nearbyEntities: new Set(nearbyEntities),
            methodCache: new Map(),
            sensedAt: Date.now(),
        };
    }

    setActiveGoal(item_name) {
        // A wrapper created as a dependency has ancestry-specific cycle pruning.
        // Reusing it later as an unrelated root can therefore hide valid methods.
        // Rebuild only when the requested root changes; within one goal the AND/OR
        // graph and its decaying method-failure history stay persistent.
        if (!this.goal || this.goal.name !== item_name) {
            this.nodes = {};
            this.failed = [];
            this.nodes[item_name] = new ItemWrapper(this, null, item_name);
        }
        this.goal = this.nodes[item_name];
        return this.goal;
    }

    previewNext(item_name, item_quantity = 1) {
        this.refreshContext();
        const goal = this.setActiveGoal(item_name);
        const next = goal.getNext(item_quantity);
        if (!next) return null;
        return {
            item: next.node.name,
            type: next.node.type,
            source: next.node.source,
            quantity: next.quantity,
            estimatedCost: goal.getDepth(item_quantity) + goal.getFails(item_quantity),
        };
    }

    async executeNext(item_name, item_quantity=1) {
        this.refreshContext();
        this.setActiveGoal(item_name);

        // Get next goal to execute
        let next_info = this.goal.getNext(item_quantity);
        if (!next_info) {
            console.log(`Invalid item goal ${this.goal.name}`);
            return false;
        }
        let next = next_info.node;
        let quantity = next_info.quantity;

        // Prevent unnecessary attempts to obtain blocks that are not nearby
        if ((next.type === 'block' && !this.context.nearbyBlocks.has(next.source)) ||
                (next.type === 'hunt' && !this.context.nearbyEntities.has(next.source))) {
            next.recordFailure();

            // If the bot has failed to obtain the block before, explore
            const failureKey = `${next.name}:${next.type}:${next.source ?? ''}`;
            if (this.failed.includes(failureKey)) {
                this.failed = this.failed.filter((item) => item !== failureKey);
                await this.agent.actions.runAction('itemGoal:explore', async () => {
                    await skills.moveAway(this.agent.bot, 8);
                });
            } else {
                this.failed.push(failureKey);
                await new Promise((resolve) => setTimeout(resolve, 500));
                this.agent.bot.emit('idle');
            }
            return false;
        }

        // Wait for the bot to be idle before attempting to execute the next goal
        if (!this.agent.isIdle())
            return false;

        // Execute the next goal
        let init_quantity = world.getInventoryCounts(this.agent.bot)[next.name] || 0;
        await this.agent.actions.runAction('itemGoal:next', async () => {
            await next.execute(quantity);
        });
        let final_quantity = world.getInventoryCounts(this.agent.bot)[next.name] || 0;

        // Log the result of the goal attempt
        if (final_quantity > init_quantity) {
            console.log(`Successfully obtained ${next.name} for goal ${this.goal.name}`);
        } else {
            console.log(`Failed to obtain ${next.name} for goal ${this.goal.name}`);
        }
        return final_quantity > init_quantity;
    }
}
