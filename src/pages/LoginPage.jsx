import { useState } from 'react';
import { useApp } from '../state/AppContext.jsx';

export default function LoginPage() {
  const { session, loginParticipant, registerParticipant, loginAdmin, logout } = useApp();
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (session.role !== 'guest') {
    return (
      <div className="card">
        <p>현재 <b>{session.name || session.email}</b> 로 로그인되어 있습니다.</p>
        <button className="ghost" onClick={logout}>로그아웃</button>
      </div>
    );
  }

  async function doParticipant(e) {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (mode === 'login') await loginParticipant(name, pin);
      else await registerParticipant(name, pin);
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }
  async function doAdmin() {
    setErr('');
    try { await loginAdmin(); }
    catch (e2) { setErr(e2.message); }
  }

  return (
    <div>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>참가자</h3>
          <div className="spacer" />
          <nav className="tabs">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setErr(''); }}>로그인</button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setErr(''); }}>가입</button>
          </nav>
        </div>
        <form className="row" onSubmit={doParticipant}>
          <input placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="PIN (숫자 4자리+)" type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
          <button className="primary" type="submit" disabled={busy}>
            {mode === 'login' ? '로그인' : '가입하기'}
          </button>
        </form>
        <p className="muted">
          {mode === 'login'
            ? '베팅판과 같은 이름·PIN으로 로그인하세요(포인트 공유). 처음이면 [가입].'
            : '이름·PIN으로 가입. 베팅판 계정이 이미 있으면 그 계정으로 로그인하면 됩니다.'}
        </p>
      </div>
      <div className="card">
        <h3>운영자 로그인</h3>
        <button className="ghost" onClick={doAdmin}>Google로 로그인</button>
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
