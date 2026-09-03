import mc from 'minecraft-protocol';

const FML_NETWORK_VERSION = 3;
const FML_LOGIN_WRAPPER = 'fml:loginwrapper';
const FML_HANDSHAKE_CHANNEL = 'fml:handshake';

const S2C_MOD_LIST = 1;
const C2S_MOD_LIST_REPLY = 2;
const S2C_REGISTRY = 3;
const S2C_CONFIG_DATA = 4;
const S2C_MOD_DATA = 5;
const S2C_CHANNEL_MISMATCH = 6;
const C2S_ACKNOWLEDGE = 99;

class BufferReader {
    constructor(buffer) {
        if (!Buffer.isBuffer(buffer)) throw new TypeError('Forge payload must be a Buffer');
        this.buffer = buffer;
        this.offset = 0;
    }

    get remaining() {
        return this.buffer.length - this.offset;
    }

    readByte() {
        if (this.remaining < 1) throw new RangeError('Unexpected end of Forge payload');
        return this.buffer[this.offset++];
    }

    readBoolean() {
        return this.readByte() !== 0;
    }

    readUnsignedShort() {
        if (this.remaining < 2) throw new RangeError('Unexpected end of Forge payload');
        const value = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return value;
    }

    readVarInt() {
        let result = 0;
        let shift = 0;
        for (let i = 0; i < 5; i++) {
            const byte = this.readByte();
            result |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) return result >>> 0;
            shift += 7;
        }
        throw new RangeError('Forge VarInt is too large');
    }

    readBytes(length) {
        if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining)
            throw new RangeError(`Invalid Forge payload length ${length}`);
        const value = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }

    readString(maxChars = 32767) {
        const byteLength = this.readVarInt();
        if (byteLength > maxChars * 4)
            throw new RangeError(`Forge string is too large (${byteLength} bytes)`);
        const value = this.readBytes(byteLength).toString('utf8');
        if (value.length > maxChars)
            throw new RangeError(`Forge string is too large (${value.length} characters)`);
        return value;
    }
}

function encodeVarInt(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff)
        throw new RangeError(`Invalid Forge VarInt ${value}`);
    const bytes = [];
    do {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) byte |= 0x80;
        bytes.push(byte);
    } while (value !== 0);
    return Buffer.from(bytes);
}

function encodeString(value, maxChars = 32767) {
    const text = String(value);
    if (text.length > maxChars)
        throw new RangeError(`Forge string is too large (${text.length} characters)`);
    const data = Buffer.from(text, 'utf8');
    if (data.length > maxChars * 4)
        throw new RangeError(`Forge string is too large (${data.length} bytes)`);
    return Buffer.concat([encodeVarInt(data.length), data]);
}

function encodeStringList(values) {
    return Buffer.concat([
        encodeVarInt(values.length),
        ...values.map(value => encodeString(value, 0x100)),
    ]);
}

function encodeChannelMap(channels) {
    const parts = [encodeVarInt(channels.size)];
    for (const [name, version] of channels) {
        parts.push(encodeString(name), encodeString(version, 0x100));
    }
    return Buffer.concat(parts);
}

function readStringList(reader, maxEntries = 65535) {
    const count = reader.readVarInt();
    if (count > maxEntries) throw new RangeError(`Forge list is too large (${count} entries)`);
    const values = [];
    for (let i = 0; i < count; i++) values.push(reader.readString(0x100));
    return values;
}

function readChannelMap(reader, maxEntries = 65535) {
    const count = reader.readVarInt();
    if (count > maxEntries) throw new RangeError(`Forge channel map is too large (${count} entries)`);
    const channels = new Map();
    for (let i = 0; i < count; i++) {
        channels.set(reader.readString(), reader.readString(0x100));
    }
    return channels;
}

function readResourceList(reader, maxEntries = 65535) {
    const count = reader.readVarInt();
    if (count > maxEntries) throw new RangeError(`Forge registry list is too large (${count} entries)`);
    const values = [];
    for (let i = 0; i < count; i++) values.push(reader.readString());
    return values;
}

export function parseForgeLoginWrapper(data) {
    const reader = new BufferReader(data);
    const target = reader.readString();
    const payloadLength = reader.readVarInt();
    const payload = reader.readBytes(payloadLength);
    if (reader.remaining !== 0)
        throw new RangeError(`Forge login wrapper has ${reader.remaining} trailing bytes`);
    return { target, payload };
}

export function encodeForgeLoginWrapper(target, payload) {
    if (!Buffer.isBuffer(payload)) throw new TypeError('Forge wrapper payload must be a Buffer');
    return Buffer.concat([encodeString(target), encodeVarInt(payload.length), payload]);
}

export function parseForgeModList(payload) {
    const reader = new BufferReader(payload);
    const discriminator = reader.readByte();
    if (discriminator !== S2C_MOD_LIST)
        throw new Error(`Expected Forge mod-list discriminator ${S2C_MOD_LIST}, got ${discriminator}`);
    const mods = readStringList(reader);
    const channels = readChannelMap(reader);
    const registries = readResourceList(reader);
    const dataPackRegistries = readResourceList(reader);
    if (reader.remaining !== 0)
        throw new RangeError(`Forge mod list has ${reader.remaining} trailing bytes`);
    return { mods, channels, registries, dataPackRegistries };
}

export function encodeForgeModListReply(modList) {
    return Buffer.concat([
        Buffer.from([C2S_MOD_LIST_REPLY]),
        encodeStringList(modList.mods),
        encodeChannelMap(modList.channels),
        encodeVarInt(0), // registry hashes are optional and Forge's own client currently sends none
    ]);
}

function encodeAcknowledge() {
    return Buffer.from([C2S_ACKNOWLEDGE]);
}

function taggedForgeHost(host, networkVersion) {
    const value = String(host);
    return value.includes('\0FML') ? value : `${value}\0FML${networkVersion}\0`;
}

function replyWithoutPayload(client, messageId) {
    client.write('login_plugin_response', { messageId });
}

function replyWrapped(client, messageId, target, payload) {
    client.write('login_plugin_response', {
        messageId,
        data: encodeForgeLoginWrapper(target, payload),
    });
}

export function installForgeHandshake(client, options = {}) {
    const debug = Boolean(options.debug);
    const state = {
        enabled: true,
        networkVersion: options.networkVersion ?? FML_NETWORK_VERSION,
        mods: [],
        channels: new Map(),
        registries: [],
        dataPackRegistries: [],
        registryPackets: 0,
        configPackets: 0,
        unknownLoginChannels: [],
        complete: false,
    };
    client.forgeHandshake = state;

    // minecraft-protocol installs a vanilla handler which rejects every login query.
    // This client owns the login-query phase, so replace that handler before the socket
    // receives the first Forge packet.
    client.removeAllListeners('login_plugin_request');
    client.on('login_plugin_request', packet => {
        try {
            if (packet.channel !== FML_LOGIN_WRAPPER) {
                if (debug) console.warn(`[forge] ignoring login channel ${packet.channel}`);
                replyWithoutPayload(client, packet.messageId);
                return;
            }

            const wrapper = parseForgeLoginWrapper(packet.data);
            if (wrapper.target !== FML_HANDSHAKE_CHANNEL) {
                state.unknownLoginChannels.push(wrapper.target);
                if (debug) console.warn(`[forge] unsupported wrapped login channel ${wrapper.target}`);
                replyWithoutPayload(client, packet.messageId);
                return;
            }
            if (wrapper.payload.length === 0) {
                replyWithoutPayload(client, packet.messageId);
                return;
            }

            const discriminator = wrapper.payload[0];
            if (debug)
                console.log(`[forge] login packet id=${packet.messageId} discriminator=${discriminator} bytes=${wrapper.payload.length}`);

            switch (discriminator) {
                case S2C_MOD_DATA:
                    // Forge marks this informational packet as no-response. Sending a
                    // vanilla negative response makes SimpleNet decode an empty payload
                    // on fml:handshake and logs an error for every connection.
                    break;
                case S2C_MOD_LIST: {
                    const modList = parseForgeModList(wrapper.payload);
                    state.mods = modList.mods;
                    state.channels = modList.channels;
                    state.registries = modList.registries;
                    state.dataPackRegistries = modList.dataPackRegistries;
                    replyWrapped(client, packet.messageId, FML_HANDSHAKE_CHANNEL, encodeForgeModListReply(modList));
                    console.log(`[forge] ${client.username}: accepted ${modList.mods.length} server mods and ${modList.channels.size} channels`);
                    client.emit('forge_mod_list', modList);
                    break;
                }
                case S2C_REGISTRY:
                    state.registryPackets += 1;
                    replyWrapped(client, packet.messageId, FML_HANDSHAKE_CHANNEL, encodeAcknowledge());
                    break;
                case S2C_CONFIG_DATA:
                    state.configPackets += 1;
                    replyWrapped(client, packet.messageId, FML_HANDSHAKE_CHANNEL, encodeAcknowledge());
                    break;
                case S2C_CHANNEL_MISMATCH:
                    replyWithoutPayload(client, packet.messageId);
                    client.emit('forge_channel_mismatch', wrapper.payload.subarray(1));
                    break;
                default:
                    state.unknownLoginChannels.push(`${wrapper.target}#${discriminator}`);
                    console.warn(`[forge] unsupported handshake discriminator ${discriminator}`);
                    replyWithoutPayload(client, packet.messageId);
                    break;
            }
        } catch (error) {
            console.error(`[forge] login handshake failed: ${error.message}`);
            replyWithoutPayload(client, packet.messageId);
            client.emit('forge_handshake_error', error);
        }
    });

    client.once('success', () => {
        state.complete = true;
        client.emit('forge_handshake_complete', state);
        if (debug)
            console.log(`[forge] handshake complete (${state.registryPackets} registry, ${state.configPackets} config packets)`);
    });
    return state;
}

export function createForgeClient(clientOptions, forgeOptions = {}) {
    const networkVersion = forgeOptions.networkVersion ?? FML_NETWORK_VERSION;
    const client = mc.createClient({
        ...clientOptions,
        fakeHost: taggedForgeHost(clientOptions.fakeHost ?? clientOptions.host, networkVersion),
        validateChannelProtocol: false,
        // Forge may reorder its command-argument registry, which the vanilla
        // decoder cannot always reconstruct. This explicit opt-in drops only an
        // invalid command-completion tree; ordinary chat/commands still work.
        ignoreInvalidCommandTree: forgeOptions.ignoreInvalidCommandTree === true,
        // Forge extends the command-argument registry. The static vanilla command-tree
        // decoder drops that optional packet as a PartialRead, so suppress ProtoDef's
        // direct stack dump while preserving real protocol error events.
        hideErrors: clientOptions.hideErrors ?? true,
    });
    installForgeHandshake(client, { ...forgeOptions, networkVersion });
    client.on('ignoredInvalidCommandTree', packet => {
        const nodes = Array.isArray(packet?.nodes) ? packet.nodes.length : 0;
        console.warn(`[forge] ${client.username}: ignored undecodable command tree (${nodes} nodes, root ${packet?.rootIndex})`);
    });
    return client;
}

export const forgeProtocol = Object.freeze({
    networkVersion: FML_NETWORK_VERSION,
    loginWrapper: FML_LOGIN_WRAPPER,
    handshakeChannel: FML_HANDSHAKE_CHANNEL,
});
