import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const installChat = require('minecraft-protocol/src/client/chat');

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.version = '1.20.1';
        this.endReason = null;
        this.errors = [];
        this.on('error', error => this.errors.push(error));
    }

    end(reason) {
        this.endReason = reason;
    }
}

function malformedForgeTree() {
    return {
        nodes: [{ children: [] }],
        rootIndex: 44,
    };
}

describe('Forge command-tree compatibility patch', () => {
    test('strict clients still reject an impossible command tree', () => {
        const client = new FakeClient();
        installChat(client, {});

        client.emit('declare_commands', malformedForgeTree());

        assert.equal(client.endReason, 'impossibleCommandTree');
        assert.match(client.errors[0]?.message ?? '', /impossible command tree/i);
    });

    test('an explicit Forge opt-in discards the tree without traversing it', () => {
        const client = new FakeClient();
        let ignored = null;
        installChat(client, { ignoreInvalidCommandTree: true });
        client.on('ignoredInvalidCommandTree', packet => { ignored = packet; });
        const packet = malformedForgeTree();

        client.emit('declare_commands', packet);

        assert.equal(client.endReason, null);
        assert.deepEqual(client.errors, []);
        assert.equal(ignored, packet);
    });
});
