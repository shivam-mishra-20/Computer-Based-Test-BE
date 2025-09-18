let admin: any = null;
let initialized = false;

export function initFirebaseAdmin() {
  if (initialized) return;
  try {
    // Lazy require to avoid hard dependency if package is not installed
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    admin = require('firebase-admin');
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (projectId && clientEmail && privateKey) {
      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
      initialized = true;
    }
  } catch {
    // ignore init errors; Firebase integration is optional
  }
}

export async function getFirestoreUserProfile(uid: string): Promise<{ name?: string; classLevel?: string; batch?: string } | null> {
  try {
    initFirebaseAdmin();
    if (!initialized) return null;
    const db = admin.firestore();
    const doc = await db.collection('Users').doc(uid).get();
    if (!doc.exists) return null;
    const data = doc.data() as any;
    return {
      name: data?.name || data?.displayName,
      classLevel: data?.class || data?.classLevel,
      batch: data?.batch,
    };
  } catch {
    return null;
  }
}

// Firebase Auth REST sign-in (uses FIREBASE_API_KEY). Returns uid and idToken if valid.
export async function firebaseSignInWithEmailPassword(email: string, password: string): Promise<{ uid: string; idToken: string; displayName?: string; emailVerified?: boolean } | null> {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    return {
      uid: data.localId,
      idToken: data.idToken,
      displayName: data.displayName,
      emailVerified: data.emailVerified,
    };
  } catch {
    return null;
  }
}

// Query Firestore Users collection by email and return the first match (admin SDK only)
export async function getFirestoreUserByEmail(email: string): Promise<null | {
  id: string;
  uid?: string;
  name?: string;
  email?: string;
  password?: string;
  role?: string;
  classLevel?: string;
  Class?: string;
  batch?: string;
}> {
  try {
    initFirebaseAdmin();
    if (!initialized) return null;
    const db = admin.firestore();
    // try top-level email first, then attendance.email
    let snap = await db.collection('Users').where('email', '==', email).limit(1).get();
    if (snap.empty) {
      snap = await db.collection('Users').where('attendance.email', '==', email).limit(1).get();
    }
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const data = doc.data() as any;
    const att = data?.attendance || {};
    const res = data?.results || {};
    return {
      id: doc.id,
      uid: data?.uid || att?.uid || doc.id,
      name: data?.name || att?.name,
      email: data?.email || att?.email,
      password: data?.password || att?.password,
      role: data?.role || res?.role,
      classLevel: data?.classLevel || data?.Class,
      Class: data?.Class,
      batch: data?.batch || att?.batch,
    };
  } catch {
    return null;
  }
}

// Helper to extract a nested field from Firestore REST document
function getField(obj: any, path: string[]): any {
  if (!obj || !obj.fields) return undefined;
  let cur: any = obj.fields;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    const val = cur[key];
    if (!val) return undefined;
    // unwrap Firestore value types
    const typeKey = Object.keys(val)[0];
    let unwrapped: any = val[typeKey];
    if (typeKey === 'mapValue') {
      cur = unwrapped; // step into mapValue
      if (i === path.length - 1) return unwrapped; // return map object
      // continue loop, but set cur to inner fields
      cur = unwrapped;
      if (!cur.fields) return undefined;
      cur = cur; // keep as is for next iteration
      // to align, set cur to fields for next key
      cur = cur; // no-op
      // Slight adjust: assign to fields for next key
      cur = unwrapped;
      // break default; next iteration will access cur[nextKey]
    } else {
      if (i === path.length - 1) return unwrapped;
      // cannot step further unless it's mapValue
      return undefined;
    }
    // set cur to inner fields for next iteration
    cur = (cur as any).fields;
  }
  return undefined;
}

async function getFirestoreUserByEmailRest(email: string): Promise<ReturnType<typeof getFirestoreUserByEmail>> {
  const apiKey = process.env.FIREBASE_API_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!apiKey || !projectId) return null;
  try {
    // Build OR filter: email == email OR attendance.email == email
    const body = {
      structuredQuery: {
        from: [{ collectionId: 'Users' }],
        where: {
          compositeFilter: {
            op: 'OR',
            filters: [
              { fieldFilter: { field: { fieldPath: 'email' }, op: 'EQUAL', value: { stringValue: email } } },
              { fieldFilter: { field: { fieldPath: 'attendance.email' }, op: 'EQUAL', value: { stringValue: email } } },
            ],
          },
        },
        limit: 1,
      },
    } as any;
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery?key=${apiKey}`;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!resp.ok) return null;
  const arr = (await resp.json()) as unknown as any[];
    const row = Array.isArray(arr) ? arr.find((r) => r.document) : null;
    const doc = row?.document;
    if (!doc) return null;
    const fields = doc;
    const topName = getField(fields, ['name']) ?? undefined;
    const attName = getField(fields, ['attendance', 'name']) ?? undefined;
    const topEmail = getField(fields, ['email']) ?? undefined;
    const attEmail = getField(fields, ['attendance', 'email']) ?? undefined;
    const topPwd = getField(fields, ['password']) ?? undefined;
    const attPwd = getField(fields, ['attendance', 'password']) ?? undefined;
    const resRole = getField(fields, ['results', 'role']) ?? undefined;
    const topRole = getField(fields, ['role']) ?? undefined;
    const topBatch = getField(fields, ['batch']) ?? undefined;
    const attBatch = getField(fields, ['attendance', 'batch']) ?? undefined;
    const classLevel = getField(fields, ['classLevel']) ?? undefined;
    const klass = getField(fields, ['Class']) ?? undefined;
    const uid = getField(fields, ['uid']) ?? getField(fields, ['attendance', 'uid']) ?? undefined;
    return {
      id: doc.name?.split('/').pop() || '',
      uid: uid,
      name: topName || attName,
      email: topEmail || attEmail,
      password: topPwd || attPwd,
      role: topRole || resRole,
      classLevel: classLevel || klass,
      Class: klass,
      batch: topBatch || attBatch,
    };
  } catch {
    return null;
  }
}

// Try Admin SDK first; if unavailable or not found, try REST fallback
export async function getFirestoreUserByEmailAny(email: string) {
  const viaAdmin = await getFirestoreUserByEmail(email);
  if (viaAdmin) return viaAdmin;
  return getFirestoreUserByEmailRest(email);
}
