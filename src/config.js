export const API = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? '/api' : '');

const TURN_USER = import.meta.env.VITE_OPENRELAY_USERNAME || '';
const TURN_CRED = import.meta.env.VITE_OPENRELAY_CREDENTIAL || '';

export const FORCE_RELAY = new URLSearchParams(location.search).has('relay');
export const HAS_TURN = !!(TURN_USER && TURN_CRED);

export function iceConfig() {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (TURN_USER && TURN_CRED) {
    iceServers.push(
      { urls: 'turn:global.relay.metered.ca:80', username: TURN_USER, credential: TURN_CRED },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: TURN_USER, credential: TURN_CRED },
      { urls: 'turn:global.relay.metered.ca:443', username: TURN_USER, credential: TURN_CRED },
      // 443/tls is the one that gets through networks that block everything else
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: TURN_USER, credential: TURN_CRED }
    );
  } else {
    console.warn('no TURN creds set, ~15% of connections will fail');
  }
  const cfg = { iceServers };
  if (FORCE_RELAY) cfg.iceTransportPolicy = 'relay';
  return cfg;
}
