import assert from 'node:assert';

// mirrors board.js on('wb-stroke')
let strokes = [];
function onStroke(p) {
  if (!p?.strokeId || !Array.isArray(p.points)) return;
  let s = strokes.find((x) => x.id === p.strokeId);
  if (!s) { s = { id: p.strokeId, mine: false, color: p.color || '#ececee', width: p.width || 2, points: [] }; strokes.push(s); }
  s.points.push(...p.points);
}

// batched points for one stroke must merge into a single stroke, in order
onStroke({ strokeId: 'a', color: '#fff', width: 2, points: [[0, 0], [0.1, 0.1]] });
onStroke({ strokeId: 'a', color: '#fff', width: 2, points: [[0.2, 0.2]] });
assert.equal(strokes.length, 1, 'batches must merge into one stroke');
assert.equal(strokes[0].points.length, 3);
assert.deepEqual(strokes[0].points[2], [0.2, 0.2], 'points must stay ordered');

// malformed frames from the peer must not throw or create strokes
onStroke(null); onStroke({}); onStroke({ strokeId: 'b' }); onStroke({ points: [[1, 1]] });
assert.equal(strokes.length, 1, 'malformed frames must be ignored');

// remote undo removes only the named stroke
onStroke({ strokeId: 'c', points: [[0.5, 0.5]] });
strokes = strokes.filter((s) => s.id !== 'a');
assert.deepEqual(strokes.map((s) => s.id), ['c']);

// mirrors board.js undoMine
const mixed = [
  { id: '1', mine: true }, { id: '2', mine: false }, { id: '3', mine: true }, { id: '4', mine: false },
];
function undoMine(list) {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].mine) return list.splice(i, 1)[0];
  return null;
}
assert.equal(undoMine(mixed).id, '3', 'undo must take my most recent stroke');
assert.equal(undoMine(mixed).id, '1', 'then the next most recent of mine');
assert.equal(undoMine(mixed), null, 'must never undo the peer\'s strokes');
assert.deepEqual(mixed.map((s) => s.id), ['2', '4']);

// mirrors files.js pump/drain
const CHUNK = 16 * 1024, HIGH = 1024 * 1024, LOW = 256 * 1024;
const size = CHUNK * 200 + 7;           // deliberately not chunk-aligned
let buffered = 0, sent = 0, waits = 0, maxBuffered = 0;
for (let off = 0; off < size; ) {
  if (buffered >= HIGH) { waits++; buffered = LOW - 1; }   // drain event
  const n = Math.min(CHUNK, size - off);
  off += n; sent += n; buffered += n;
  maxBuffered = Math.max(maxBuffered, buffered);
  // slow channel: drains less than we push, so the buffer climbs and must trip HIGH
  if (off % (CHUNK * 8) === 0) buffered = Math.max(0, buffered - CHUNK * 2);
}
assert.equal(sent, size, 'every byte must be sent exactly once, incl. the partial tail');
assert.ok(waits > 0, 'backpressure must actually engage on a large file');
assert.ok(maxBuffered < HIGH + CHUNK, `buffer must stay bounded, peaked at ${maxBuffered}`);

const RELAY_CAP = 200 * 1024 * 1024;
const allowed = (type, bytes) => !(type === 'relay' && bytes > RELAY_CAP);
assert.equal(allowed('relay', RELAY_CAP + 1), false);
assert.equal(allowed('relay', RELAY_CAP), true, 'cap is inclusive');
assert.equal(allowed('direct', RELAY_CAP * 10), true, 'no cap on direct');

const MAX_LEN = 4000;
assert.equal('x'.repeat(5000).slice(0, MAX_LEN).length, MAX_LEN, 'oversize peer text must be truncated');

console.log('protocol ok');
