// node server/store.test.js  (runs against the memory store, no db needed)
import assert from 'node:assert';
import * as store from './store.js';

assert.ok(store.usingMemory, 'unset DB_HOST before running this');

const a = await store.upsertUser({ sub: 'dev:a', name: 'Ann', email: 'a@x.com' });
const b = await store.upsertUser({ sub: 'dev:b', name: 'Bob', email: 'b@x.com' });

// upsert is idempotent
const a2 = await store.upsertUser({ sub: 'dev:a', name: 'Ann', email: 'a@x.com' });
assert.equal(a.id, a2.id, 'same sub must not create a second user');

assert.equal((await store.findUserByEmailOrName('b@x.com')).id, b.id);
assert.equal((await store.findUserByEmailOrName('Ann')).id, a.id);
assert.equal(await store.findUserByEmailOrName('nobody'), null);

// pending request shows up for the addressee only
const fr = await store.createFriendRequest(a.id, b.id);
assert.equal((await store.listPending(b.id)).length, 1);
assert.equal((await store.listPending(a.id)).length, 0);
assert.equal((await store.listFriends(a.id)).length, 0, 'pending is not a friend yet');

// duplicate request in either direction must not create a second row
await store.createFriendRequest(a.id, b.id);
await store.createFriendRequest(b.id, a.id);
assert.equal((await store.listPending(b.id)).length, 1, 'duplicate requests');

// only the addressee can accept
assert.equal(await store.respondToRequest(fr.id, a.id, true), false, 'requester must not self-accept');
assert.equal(await store.respondToRequest(fr.id, b.id, true), true);

// accepted shows for both sides, offline until a heartbeat
const friendsOfA = await store.listFriends(a.id);
assert.equal(friendsOfA.length, 1);
assert.equal(friendsOfA[0].user_id, b.id);
assert.equal(friendsOfA[0].online, false);
assert.equal(friendsOfA[0].peer_id, null, 'no peer id leaks while offline');
assert.equal((await store.listFriends(b.id))[0].user_id, a.id);

// heartbeat flips presence and exposes the peer id
await store.heartbeat(b.id, 'peer-xyz');
const afterBeat = (await store.listFriends(a.id))[0];
assert.equal(afterBeat.online, true);
assert.equal(afterBeat.peer_id, 'peer-xyz');

await store.clearPresence(b.id);
assert.equal((await store.listFriends(a.id))[0].online, false);

// decline removes the row
const c = await store.upsertUser({ sub: 'dev:c', name: 'Cal' });
const fr2 = await store.createFriendRequest(c.id, a.id);
assert.equal(await store.respondToRequest(fr2.id, a.id, false), true);
assert.equal((await store.listPending(a.id)).length, 0);
assert.equal((await store.listFriends(a.id)).length, 1, 'declining must not create a friendship');

console.log('store ok');
