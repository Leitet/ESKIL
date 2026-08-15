// Testhjälpare — noll beroenden.
//
// Reglerna testas genom Firestore-emulatorns REST-API med SJÄLVGJORDA osignerade
// JWT:er, vilket emulatorn accepterar. Det gör att hela säkerhetsmodellen kan
// provas utan att dra in @firebase/rules-unit-testing (eller något byggsteg) i
// ett projekt som medvetet saknar båda delarna.
//
// Kräver en igång-varande emulator:
//   npx -y firebase-tools@13.35.1 emulators:start --project demo-eskil \
//     --only hosting,firestore,auth,functions
// Kör sviten med scripts/test.sh

export const PROJECT = 'demo-eskil';
export const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
export const BASE = `http://${FS_HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

// Osignerad token i emulatorns format. `alg: none` godtas bara av emulatorn —
// aldrig av produktion.
export function authToken(uid, email) {
  const header = { alg: 'none', typ: 'JWT' };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: uid,
    user_id: uid,
    email,
    email_verified: true,
    auth_time: 1,
    iat: 1,
    exp: 9999999999,
    firebase: { identities: { email: [email] }, sign_in_provider: 'password' }
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

// `as` väljer identitet: null = anonym, 'owner' = admin-bypass (seedning),
// annars { uid, email }.
function headers(as) {
  const h = { 'Content-Type': 'application/json' };
  if (as === 'owner') h.Authorization = 'Bearer owner';
  else if (as) h.Authorization = `Bearer ${authToken(as.uid, as.email)}`;
  return h;
}

// --- Värdekonvertering mot Firestores REST-format ---------------------------
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v)
    ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}
export const toFields = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toValue(v)]));

export function fromValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return v;
}
export const fromFields = (f) =>
  Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fromValue(v)]));

// --- Operationer -------------------------------------------------------------
// Alla returnerar { ok, status } så testerna kan påstå TILLÅTEN/NEKAD utan
// try/catch runt varje anrop.

export async function write(path, data, as, { merge = false } = {}) {
  const mask = merge
    ? '?' + Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&')
    : '';
  const res = await fetch(`${BASE}/${path}${mask}`, {
    method: 'PATCH', headers: headers(as), body: JSON.stringify({ fields: toFields(data) })
  });
  return { ok: res.ok, status: res.status };
}

export async function read(path, as) {
  const res = await fetch(`${BASE}/${path}`, { headers: headers(as) });
  const body = res.ok ? await res.json() : null;
  return { ok: res.ok, status: res.status, data: body ? fromFields(body.fields) : null };
}

export async function list(path, as) {
  const res = await fetch(`${BASE}/${path}?pageSize=100`, { headers: headers(as) });
  const body = res.ok ? await res.json() : null;
  return {
    ok: res.ok, status: res.status,
    docs: (body?.documents || []).map(d => ({ id: d.name.split('/').pop(), ...fromFields(d.fields) }))
  };
}

export async function remove(path, as) {
  const res = await fetch(`${BASE}/${path}`, { method: 'DELETE', headers: headers(as) });
  return { ok: res.ok, status: res.status };
}

// Seedning går alltid som 'owner' (förbi reglerna) så testdata aldrig blockeras
// av just det man testar.
export const seed = (path, data) => write(path, data, 'owner');

export async function wipe(path) {
  const { docs } = await list(path, 'owner');
  for (const d of docs) await remove(`${path}/${d.id}`, 'owner');
}

// Unik prefix per körning så parallella tester och rester från tidigare
// körningar aldrig krockar.
export const uniq = (p = 't') => `${p}-${Math.random().toString(36).slice(2, 10)}`;

export async function emulatorRunning() {
  try {
    const res = await fetch(`http://${FS_HOST}/`);
    return res.status < 500;
  } catch { return false; }
}
