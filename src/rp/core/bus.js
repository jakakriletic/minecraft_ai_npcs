// In-process event bus shared by all NPCs (witnessed trades, future gossip hooks).
import { EventEmitter } from 'events';
export const bus = new EventEmitter();
bus.setMaxListeners(50);
