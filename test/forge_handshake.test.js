import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import {
    encodeForgeLoginWrapper,
    encodeForgeModListReply,
    forgeProtocol,
    installForgeHandshake,
    parseForgeLoginWrapper,
    parseForgeModList,
} from '../src/utils/forge_handshake.js';

function varInt(value) {
    const bytes = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value) byte |= 0x80;
        bytes.push(byte);
    } while (value);
    return Buffer.from(bytes);
}

function string(value) {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([varInt(bytes.length), bytes]);
}

function list(values) {
    return Buffer.concat([varInt(values.length), ...values.map(string)]);
}

function serverModListPayload() {
    return Buffer.concat([
        Buffer.from([1]),
        list(['minecraft', 'forge', 'the_knocker']),
        varInt(2),
        string('fml:handshake'), string('FML3'),
        string('the_knocker:the_knocker'), string('1'),
        list(['minecraft:item']),
        list([]),
    ]);
}

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.username = 'TestBot';
        this.writes = [];
    }

    write(name, data) {
        this.writes.push({ name, data });
    }
}

describe('Forge 1.20.1 FML3 handshake', () => {
    test('round-trips a login wrapper', () => {
        const payload = Buffer.from([99]);
        const encoded = encodeForgeLoginWrapper(forgeProtocol.handshakeChannel, payload);
        assert.deepEqual(parseForgeLoginWrapper(encoded), {
            target: forgeProtocol.handshakeChannel,
            payload,
        });
    });

    test('parses the server mod list and encodes a matching client reply', () => {
        const parsed = parseForgeModList(serverModListPayload());
        assert.deepEqual(parsed.mods, ['minecraft', 'forge', 'the_knocker']);
        assert.equal(parsed.channels.get('fml:handshake'), 'FML3');
        assert.equal(parsed.channels.get('the_knocker:the_knocker'), '1');
        assert.deepEqual(parsed.registries, ['minecraft:item']);

        const reply = encodeForgeModListReply(parsed);
        assert.equal(reply[0], 2);
        assert.ok(reply.includes(Buffer.from('the_knocker:the_knocker')));
    });

    test('replaces the vanilla negative-query handler and answers the FML mod list', () => {
        const client = new FakeClient();
        let vanillaHandlerCalled = false;
        client.on('login_plugin_request', () => { vanillaHandlerCalled = true; });
        installForgeHandshake(client);

        client.emit('login_plugin_request', {
            messageId: 7,
            channel: forgeProtocol.loginWrapper,
            data: encodeForgeLoginWrapper(forgeProtocol.handshakeChannel, serverModListPayload()),
        });

        assert.equal(vanillaHandlerCalled, false);
        assert.equal(client.writes.length, 1);
        assert.equal(client.writes[0].name, 'login_plugin_response');
        assert.equal(client.writes[0].data.messageId, 7);
        const wrapper = parseForgeLoginWrapper(client.writes[0].data.data);
        assert.equal(wrapper.target, forgeProtocol.handshakeChannel);
        assert.equal(wrapper.payload[0], 2);
        assert.equal(client.forgeHandshake.channels.size, 2);
    });

    test('does not answer Forge informational mod-data packets', () => {
        const client = new FakeClient();
        installForgeHandshake(client);

        client.emit('login_plugin_request', {
            messageId: 8,
            channel: forgeProtocol.loginWrapper,
            data: encodeForgeLoginWrapper(forgeProtocol.handshakeChannel, Buffer.from([5])),
        });

        assert.deepEqual(client.writes, []);
    });
});
