// src/firestore.js
//
// Minimal Firestore client using plain HTTPS + the public REST API --
// deliberately NOT the firebase npm package. We only need two operations
// ("write my total", "read everyone's totals this month"), and Firestore's
// REST API handles both in a few dozen lines with zero new dependencies.
// This mirrors the existing Imgur-upload pattern already used elsewhere in
// this app (raw `https.request`, no SDK), so it fits the project's style.
//
// Auth note: Firestore's REST API accepts unauthenticated requests as long
// as security rules allow it. We're relying on rules (set up separately in
// the Firebase console) to restrict writes to a user's own document, rather
// than embedding any secret here -- there is no secret to embed; the
// firebaseConfig values (apiKey, projectId, etc.) are public-by-design, the
// same way they'd be visible in any web app's bundled JS.

const https = require('https');

const PROJECT_ID = 'musictodiscord-leaderboard';
const BASE_HOST = 'firestore.googleapis.com';
const BASE_PATH = `/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: BASE_HOST,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 10000,
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          try {
            const json = resBody ? JSON.parse(resBody) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(json);
            } else {
              reject(new Error(`Firestore ${method} ${path} -> ${res.statusCode}: ${resBody.slice(0, 300)}`));
            }
          } catch (e) {
            reject(new Error(`Firestore response parse error: ${e.message} body=${resBody.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Firestore request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// Firestore's REST API represents field values as { stringValue: ... } /
// { integerValue: ... } / { timestampValue: ... } etc, rather than plain
// JSON -- these two helpers convert to/from that shape so the rest of the
// app can just deal with normal JS objects.

function toFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      fields[key] = { stringValue: value };
    } else if (typeof value === 'number') {
      fields[key] = Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value };
    } else if (value instanceof Date) {
      fields[key] = { timestampValue: value.toISOString() };
    } else if (typeof value === 'boolean') {
      fields[key] = { booleanValue: value };
    }
  }
  return fields;
}

function fromFirestoreFields(fields) {
  const obj = {};
  if (!fields) return obj;
  for (const [key, value] of Object.entries(fields)) {
    if ('stringValue' in value) obj[key] = value.stringValue;
    else if ('integerValue' in value) obj[key] = parseInt(value.integerValue, 10);
    else if ('doubleValue' in value) obj[key] = value.doubleValue;
    else if ('booleanValue' in value) obj[key] = value.booleanValue;
    else if ('timestampValue' in value) obj[key] = value.timestampValue;
  }
  return obj;
}

// Encodes a value for safe use as a Firestore document ID segment in a URL
// path -- usernames can contain characters that aren't valid there as-is.
function encodeDocId(id) {
  return encodeURIComponent(id);
}

// Writes (creates or fully overwrites) one document at
// leaderboard/{docId}. Using PATCH with no updateMask means "replace the
// whole document with exactly these fields" -- simpler than juggling partial
// updates, and fine here since we always write the complete record anyway.
async function setLeaderboardEntry(docId, data) {
  const path = `${BASE_PATH}/leaderboard/${encodeDocId(docId)}`;
  await request('PATCH', path, { fields: toFirestoreFields(data) });
}

// Lists every document in the `leaderboard` collection. The free/simple
// REST "list documents" endpoint doesn't support server-side filtering by a
// field value without a separate structured-query call, so we just fetch
// everything and filter by month client-side -- the realistic size of this
// collection (one doc per user per month) is small enough that this is not
// a meaningful cost or performance concern.
async function listLeaderboardEntries() {
  const path = `${BASE_PATH}/leaderboard?pageSize=300`;
  const result = await request('GET', path);
  const docs = result.documents || [];
  return docs.map((doc) => {
    const idParts = doc.name.split('/');
    return {
      id: idParts[idParts.length - 1],
      ...fromFirestoreFields(doc.fields),
    };
  });
}

// Deletes one leaderboard document (e.g. "removes my stats" for a given
// month). Firestore's DELETE is idempotent -- deleting a doc that doesn't
// exist isn't an error -- so callers don't need to check existence first.
async function deleteLeaderboardEntry(docId) {
  const path = `${BASE_PATH}/leaderboard/${encodeDocId(docId)}`;
  await request('DELETE', path);
}

// ---- Username claims ----
// A separate `usernames` collection, one doc per claimed name, holding the
// device ID that claimed it. This is the actual ownership record -- the
// leaderboard collection itself can't serve that role since entries are
// per-month and could be deleted (e.g. via deleteLeaderboardEntry above)
// without the name itself becoming free again, which would be wrong.

// Returns the deviceId that owns `name`, or null if it's unclaimed.
async function getUsernameOwner(name) {
  const path = `${BASE_PATH}/usernames/${encodeDocId(name)}`;
  try {
    const doc = await request('GET', path);
    const fields = fromFirestoreFields(doc.fields);
    return fields.deviceId || null;
  } catch (e) {
    // Firestore's REST API returns a 404-shaped error for a missing
    // document rather than an empty success response -- that's the
    // expected, normal case for an unclaimed name, not a real failure.
    if (/404/.test(e.message)) return null;
    throw e;
  }
}

// Claims `name` for `deviceId`. Callers are expected to have already
// checked getUsernameOwner() and confirmed it's either unclaimed or already
// owned by this same deviceId -- this function itself does not re-check,
// since the main.js caller needs to do that check anyway to decide whether
// to show a "name taken" error, and doing it twice would just be redundant
// network calls without closing any real race (Firestore security rules,
// not this client code, are the actual enforcement point against a
// determined bad actor -- this is a casual-collision guard, not real auth).
async function claimUsername(name, deviceId) {
  const path = `${BASE_PATH}/usernames/${encodeDocId(name)}`;
  await request('PATCH', path, {
    fields: toFirestoreFields({ deviceId, claimedAt: new Date() }),
  });
}

// ---- Dev mode kill switch ----
// The `system/devModeKillSwitch` document holds a single boolean field
// `killed`. When true, any install that has locally unlocked J@R3D dev mode
// will have it suppressed. R3D_EYE (owner mode) is never affected.
//
// Every install reads this doc during its normal leaderboard sync cadence
// (no extra polling). Owner installs can flip it via setDevModeKillSwitch.

async function getDevModeKillSwitch() {
  const path = `${BASE_PATH}/system/devModeKillSwitch`;
  try {
    const doc = await request('GET', path);
    const fields = fromFirestoreFields(doc.fields);
    return !!fields.killed;
  } catch (e) {
    if (/404/.test(e.message)) return false; // doc doesn't exist yet → not killed
    throw e;
  }
}

async function setDevModeKillSwitch(killed) {
  const path = `${BASE_PATH}/system/devModeKillSwitch`;
  await request('PATCH', path, {
    fields: toFirestoreFields({ killed: !!killed, updatedAt: new Date() }),
  });
}

// ---- Admin: list ALL leaderboard entries (any month) ----
// Used by J@R3D / R3D_EYE dev panel, which needs to see everything, not just
// the current month's filtered view that normal users get.
async function listAllLeaderboardEntries() {
  const path = `${BASE_PATH}/leaderboard?pageSize=500`;
  const result = await request('GET', path);
  const docs = result.documents || [];
  return docs.map((doc) => {
    const idParts = doc.name.split('/');
    return {
      id: decodeURIComponent(idParts[idParts.length - 1]),
      ...fromFirestoreFields(doc.fields),
    };
  });
}

module.exports = {
  setLeaderboardEntry,
  listLeaderboardEntries,
  listAllLeaderboardEntries,
  deleteLeaderboardEntry,
  getUsernameOwner,
  claimUsername,
  getDevModeKillSwitch,
  setDevModeKillSwitch,
};
