'use strict';

const DEFAULT_JOIN_WINDOW_MS = 60 * 1000;
const DEFAULT_SOCKET_JOIN_ATTEMPTS = 12;
const DEFAULT_ADDRESS_JOIN_ATTEMPTS = 60;

function validSignalingRoom(value) {
  const parts = String(value).split(':');
  const [base, suffix] = parts;
  // Human friend-invite codes are intentionally not accepted here. A relay
  // room is a private capability exchanged through an authenticated channel.
  return parts.length <= 2
    && /^[A-Z0-9_-]{24,64}$/.test(base)
    && (suffix === undefined || suffix.toLowerCase() === 'stream');
}

function signalingJoinAddress(socket, request, { trustProxy = process.env.PAIR_TRUST_PROXY === '1' } = {}) {
  if (trustProxy) {
    const forwarded = String(request?.headers?.['cf-connecting-ip'] || request?.headers?.['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded.slice(0, 128);
  }
  return String(socket?._socket?.remoteAddress || 'unknown').slice(0, 128);
}

class RoomJoinLimiter {
  constructor({
    windowMs = DEFAULT_JOIN_WINDOW_MS,
    maxSocketAttempts = DEFAULT_SOCKET_JOIN_ATTEMPTS,
    maxAddressAttempts = DEFAULT_ADDRESS_JOIN_ATTEMPTS,
    now = Date.now,
  } = {}) {
    this.windowMs = windowMs;
    this.maxSocketAttempts = maxSocketAttempts;
    this.maxAddressAttempts = maxAddressAttempts;
    this.now = now;
    this.byAddress = new Map();
  }

  allow(socket) {
    const now = this.now();
    if (!socket._joinWindowAt || now - socket._joinWindowAt >= this.windowMs) {
      socket._joinWindowAt = now;
      socket._joinAttempts = 0;
    }
    if (++socket._joinAttempts > this.maxSocketAttempts) return false;

    const address = socket._joinAddress || 'unknown';
    const previous = this.byAddress.get(address);
    const record = !previous || now - previous.startedAt >= this.windowMs
      ? { startedAt: now, attempts: 0 }
      : previous;
    record.attempts++;
    this.byAddress.set(address, record);
    return record.attempts <= this.maxAddressAttempts;
  }

  sweep() {
    const cutoff = this.now() - this.windowMs;
    for (const [address, record] of this.byAddress) {
      if (record.startedAt <= cutoff) this.byAddress.delete(address);
    }
  }
}

module.exports = {
  DEFAULT_JOIN_WINDOW_MS,
  RoomJoinLimiter,
  signalingJoinAddress,
  validSignalingRoom,
};
