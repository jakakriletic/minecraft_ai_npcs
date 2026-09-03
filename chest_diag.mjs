// Temp diagnostic: connect a bot, open a public-storage chest, log every
// window/transaction packet with timestamps to see why chests "instantly close".
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';

const { pathfinder, Movements, goals } = pathfinderPkg;

const HOST = '127.0.0.1', PORT = 25565, VERSION = '1.20.1';
const CHEST = { x: 468, y: 66, z: 9 };

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s]`, ...a);

const bot = mineflayer.createBot({ username: 'Terminator', host: HOST, port: PORT, auth: 'offline', version: VERSION });
bot.loadPlugin(pathfinder);

bot.on('error', e => log('BOT ERROR', e.message));
bot.on('kicked', r => log('KICKED', JSON.stringify(r)));
bot.on('end', r => log('END', r));

for (const pkt of ['open_window', 'close_window', 'transaction', 'window_items']) {
    bot._client.on(pkt, p => {
        const info = pkt === 'window_items' ? `windowId=${p.windowId} items=${p.items?.length}` : JSON.stringify(p).slice(0, 160);
        log(`<< ${pkt}`, info);
    });
}
const origWrite = bot._client.write.bind(bot._client);
bot._client.write = (name, data) => {
    if (['close_window', 'window_click', 'block_place'].includes(name))
        log(`>> ${name}`, JSON.stringify(data).slice(0, 160));
    return origWrite(name, data);
};
bot.on('windowOpen', w => log('EVENT windowOpen id=' + w.id, 'type=' + w.type, 'slots=' + w.slots.length));
bot.on('windowClose', w => log('EVENT windowClose id=' + (w?.id ?? '?')));

bot.once('spawn', async () => {
    log('spawned at', bot.entity.position.toString(), 'gameMode=', bot.game.gameMode);
    bot.chat(`/tp @s ${CHEST.x + 1} ${CHEST.y} ${CHEST.z + 1}`);
    await new Promise(r => setTimeout(r, 3000));
    log('after tp, at', bot.entity.position.toString());
    if (bot.entity.position.distanceTo(CHEST) > 20) {
        try {
            const movements = new Movements(bot);
            movements.canDig = false;
            bot.pathfinder.setMovements(movements);
            log('tp failed, pathfinding to chest', JSON.stringify(CHEST));
            await bot.pathfinder.goto(new goals.GoalNear(CHEST.x, CHEST.y, CHEST.z, 2));
            log('arrived');
        } catch (e) { log('path error:', e.message); }
    }

    const { Vec3 } = await import('vec3');
    const chestBlock = bot.blockAt(new Vec3(CHEST.x, CHEST.y, CHEST.z));
    log('chest block =', chestBlock?.name, 'meta=', chestBlock?.metadata);
    if (!chestBlock || !chestBlock.name.includes('chest')) { log('no chest here, abort'); bot.quit(); process.exit(0); }

    for (let attempt = 1; attempt <= 3; attempt++) {
        log(`--- open attempt ${attempt} ---`);
        try {
            const win = await bot.openContainer(chestBlock);
            log('opened OK, containerItems =', win.containerItems().map(i => `${i.count}x${i.name}`).join(', ') || '(empty)');
            await new Promise(r => setTimeout(r, 2500));
            const first = win.containerItems()[0];
            if (first) {
                log('trying withdraw 1x', first.name);
                try { await win.withdraw(first.type, first.metadata, 1, first.nbt); log('withdraw OK'); }
                catch (e) { log('withdraw FAILED:', e.message); }
                try { await win.deposit(first.type, first.metadata, 1, first.nbt); log('deposit-back OK'); }
                catch (e) { log('deposit-back FAILED:', e.message); }
            }
            try { await win.close(); log('closed'); } catch (e) { log('close failed:', e.message); }
        } catch (e) {
            log('open FAILED:', e.message);
        }
        await new Promise(r => setTimeout(r, 1500));
    }
    log('done');
    bot.quit();
    setTimeout(() => process.exit(0), 1000);
});

setTimeout(() => { log('TIMEOUT, exiting'); process.exit(1); }, 120000);
