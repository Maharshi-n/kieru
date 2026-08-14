import { API } from './config.js';

let token = localStorage.getItem('token') || null;

export function getToken() { return token; }

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('token', t);
  else localStorage.removeItem('token');
}

async function req(method, path, body) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    setToken(null);
    location.reload();
    throw new Error('session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed`);
  return data;
}

export const get = (p) => req('GET', p);
export const post = (p, b) => req('POST', p, b);

export function clearPresenceBeacon() {
  if (!token) return;
  navigator.sendBeacon(API + '/presence/clear', JSON.stringify({ token }));
}
