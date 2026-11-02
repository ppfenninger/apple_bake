// Signed session cookies. Two roles: "admin" (organizers, ADMIN_PASSWORD) and
// "checkin" (the entry-table laptop, the event's check-in PIN).
const COOKIE = 'bake_session';
const enc = new TextEncoder();

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode('bake-session:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
}

/** Constant-time-ish string comparison. */
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function makeCookie(env, role, hours = 24) {
  const exp = Date.now() + hours * 3600 * 1000;
  const payload = role + '.' + exp;
  const sig = await hmac(env.ADMIN_PASSWORD || '', payload);
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${hours * 3600}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Returns "admin", "checkin" or null. */
export async function sessionRole(request, env) {
  if (!env.ADMIN_PASSWORD) return null;
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return null;
  const [role, exp, sig] = m[1].split('.');
  if (!role || !exp || !sig || Number(exp) < Date.now()) return null;
  const want = await hmac(env.ADMIN_PASSWORD, role + '.' + exp);
  return safeEqual(sig, want) ? role : null;
}
