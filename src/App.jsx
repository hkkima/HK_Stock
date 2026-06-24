import { useState } from 'react';
import { useApp } from './state/AppContext.jsx';
import MarketPage from './pages/MarketPage.jsx';
import PortfolioPage from './pages/PortfolioPage.jsx';
import LeaderboardPage from './pages/LeaderboardPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import LoginPage from './pages/LoginPage.jsx';

export default function App() {
  const { configured, session, myUser, logout } = useApp();
  const [tab, setTab] = useState('market');

  const isAdmin = session.role === 'admin';
  const isParticipant = session.role === 'participant';
  const who =
    isParticipant ? session.name
    : isAdmin ? `운영자 (${session.email})`
    : '게스트';

  return (
    <div>
      <header className="top">
        <h1>📈 수강생 주식판</h1>
        <nav className="tabs">
          <button className={tab === 'market' ? 'active' : ''} onClick={() => setTab('market')}>시세</button>
          {isParticipant && <button className={tab === 'me' ? 'active' : ''} onClick={() => setTab('me')}>내 자산</button>}
          <button className={tab === 'rank' ? 'active' : ''} onClick={() => setTab('rank')}>리더보드</button>
          {isAdmin && <button className={tab === 'admin' ? 'active' : ''} onClick={() => setTab('admin')}>운영자</button>}
          <button className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
            {session.role === 'guest' ? '로그인' : '계정'}
          </button>
        </nav>
        <div className="spacer" />
        {isParticipant && myUser && <span className="balance mono">{(myUser.balance || 0).toLocaleString()} P</span>}
        <span className="muted">{who}</span>
        {session.role !== 'guest' && <button className="ghost" onClick={logout}>로그아웃</button>}
      </header>

      <div className="wrap">
        {!configured && (
          <div className="banner">
            ⚙️ Firebase가 아직 설정되지 않았어요. <code>.env</code>에 <code>VITE_FIREBASE_*</code> 값(베팅판과 동일한 프로젝트)을
            채우면 실시간 시세가 동작합니다. 지금은 UI 미리보기만 가능.
          </div>
        )}
        {tab === 'market' && <MarketPage />}
        {tab === 'me' && isParticipant && <PortfolioPage />}
        {tab === 'rank' && <LeaderboardPage />}
        {tab === 'admin' && isAdmin && <AdminPage />}
        {tab === 'login' && <LoginPage />}
      </div>
    </div>
  );
}
