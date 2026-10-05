/**
 * Phone alerts: the browser's Web Push, subscribed against this app's own service worker.
 *
 * The back office (timekeeper-online) has had this for months; this app had a bell and a
 * feed but never asked the phone for permission, so nothing a salesperson needed to know
 * (a request decided, a birthday coming, an overdue follow-up) reached them unless they
 * happened to open the app. The same `push_subscriptions` table and the same delivery job
 * serve both apps; a subscription belongs to the app scope it was made from.
 */
import { supabase } from './supabase';

// VAPID public key (safe to ship). The private key lives only in Supabase (push_config).
const VAPID_PUBLIC = 'BCuMWlRm0tjzqkOHVmvMA_4o4OOlurmpkRjIi8qsaSZeoNkRy2aLny3SXSjbghmfMMUsSnQngGXWObpRCvOstAI';

export const pushSupported = () =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** iPhone/iPad Safari can only push when the app was added to the home screen and opened from there. */
export const isIosNotInstalled = () => {
  if (typeof navigator === 'undefined') return false;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = ('standalone' in navigator && (navigator as unknown as { standalone: boolean }).standalone) ||
    window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
};

function urlB64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export type PushState =
  | 'unsupported'   // this browser cannot do it at all
  | 'needs-install' // iPhone, not yet added to the home screen
  | 'blocked'       // the person said no; only phone Settings can undo that
  | 'off'           // can be turned on
  | 'on';

export async function pushState(): Promise<PushState> {
  if (isIosNotInstalled()) return 'needs-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  /* A phone that turned alerts on before subscriptions carried an app name was recorded as the
     back office's. Say so once it opens this app, so its alerts are the shop's and not both. */
  if (sub) void supabase.from('push_subscriptions').update({ app: 'dsr' }).eq('endpoint', sub.endpoint).neq('app', 'dsr');
  return sub ? 'on' : 'off';
}

export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (isIosNotInstalled()) return { ok: false, error: 'On iPhone, first add the app to your home screen (Share → Add to Home Screen), then open it from there.' };
  if (!pushSupported()) return { ok: false, error: 'This browser cannot show alerts.' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, error: 'Alerts were not allowed. You can allow them in your phone’s Settings.' };
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' }));
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC) });
  const j = sub.toJSON();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'You are not signed in.' };
  const { error } = await supabase.from('push_subscriptions').upsert(
    { user_id: user.id, endpoint: sub.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, ua: navigator.userAgent, app: 'dsr' },
    { onConflict: 'endpoint' },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
