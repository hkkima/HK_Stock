// Firebase 초기화. 키가 없으면 import 단계에서 터지지 않도록 지연 초기화.
// ★ 베팅판과 같은 projectId 를 써야 포인트(users.balance)가 공유됨 ★
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  getAuth,
  signInAnonymously,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
} from 'firebase/auth';

function readConfig() {
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  };
}

let cache = null;

export function isConfigured() {
  const c = readConfig();
  return Boolean(c.apiKey && c.projectId);
}

export function getFirebase() {
  if (cache) return cache;
  const config = readConfig();
  if (!config.apiKey || !config.projectId) {
    throw new Error('Firebase 설정이 없어요. .env 에 VITE_FIREBASE_* 값을 채워 주세요.');
  }
  const app = getApps()[0] || initializeApp(config);
  const region = import.meta.env.VITE_FUNCTIONS_REGION || 'us-central1';
  cache = { app, db: getFirestore(app), auth: getAuth(app), functions: getFunctions(app, region) };
  return cache;
}

// 호출 가능 함수 래퍼 — 모든 거래/펀더멘탈 변동은 이걸 통과한다.
//   인증 누락(internal/unauthenticated)은 재로그인 안내 메시지로 변환.
export function callable(name) {
  const fn = httpsCallable(getFirebase().functions, name);
  return async (data) => {
    try { return await fn(data); }
    catch (e) {
      const code = String(e?.code || '');
      if (/unauthenticated|internal|unauthorized|permission-denied/.test(code)) {
        const err = new Error('운영자 로그인이 만료된 것 같습니다. [계정]에서 Google로 다시 로그인 후 시도하세요.');
        err.code = code; throw err;
      }
      throw e;
    }
  };
}

let anonPromise = null;

// 참가자용 익명 로그인 — 함수 호출에 request.auth 가 필요.
export function ensureAnonAuth() {
  let auth;
  try {
    auth = getFirebase().auth;
  } catch {
    return Promise.resolve(null);
  }
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  if (!anonPromise) {
    anonPromise = signInAnonymously(auth)
      .then((c) => c.user)
      .catch((e) => {
        console.warn('익명 로그인 실패(Authentication→익명 켜기 필요):', e.code || e.message);
        return null;
      });
  }
  return anonPromise;
}

// 운영자 구글 로그인 (팝업). 이메일이 화이트리스트면 운영자.
export async function signInWithGoogle() {
  const { auth } = getFirebase();
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

// Firebase 인증 상태 추적(운영자 구글 세션 만료 감지용). 콜백에 user|null.
export function watchAuth(cb) {
  try { return onAuthStateChanged(getFirebase().auth, cb); }
  catch { cb(null); return () => {}; }
}

export function adminEmails() {
  const raw = import.meta.env.VITE_ADMIN_EMAILS || '';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isAdminEmail(email) {
  const list = adminEmails();
  if (!email) return false;
  if (list.length === 0) return true; // 미설정 시 구글 로그인=누구나 운영자(로컬 테스트)
  return list.includes(String(email).toLowerCase());
}
