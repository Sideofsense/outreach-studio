'use strict';

const { EventEmitter } = require('node:events');

/**
 * Singleton event bus for send-queue → SSE clients.
 * No persistence; events are fire-and-forget. Subscribers that miss events
 * during a disconnect can recover their state via /api/drafts and /api/sends.
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

function emit(event) {
  bus.emit('event', event);
}

function subscribe(handler) {
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

module.exports = { emit, subscribe };
