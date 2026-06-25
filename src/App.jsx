import { useState } from 'react';
import { useApp } from './state/AppContext.jsx';
import MarketPage from './pages/MarketPage.jsx';
import PortfolioPage from './pages/PortfolioPage.jsx';
import NewsPage from './pages/NewsPage.jsx';
import LeaderboardPage from './pages/LeaderboardPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import LoginPage from './pages/LoginPage.jsx';

export default function App() {
  const { configured, session, myUser, logout, adminReauthNeeded, loginAdmin } = useApp();
  const [tab, setTab] = useState('market');

  async function reauth() {
    try { await loginAdmin(); } catch (e) { window.alert(e.message); }
  }

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
          <button className={tab === 'news' ? 'active' : ''} onClick={() => setTab('news')}>뉴스</button>
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
        {adminReauthNeeded && (
          <div className="banner" style={{ background: '#3a0a0a', borderColor: 'var(--down)', color: 'var(--down)' }}>
            🔑 운영자 구글 인증이 만료됐습니다(발행·배당·뉴스 등 운영자 동작이 안 됩니다).
            <button className="primary" style={{ marginLeft: 8 }} onClick={reauth}>Google로 다시 로그인</button>
          </div>
        )}
        {!configured && (
          <div className="banner">
            ⚙️ Firebase가 아직 설정되지 않았어요. <code>.env</code>에 <code>VITE_FIREBASE_*</code> 값(베팅판과 동일한 프로젝트)을
            채우면 실시간 시세가 동작합니다. 지금은 UI 미리보기만 가능.
          </div>
        )}
        {tab === 'market' && <MarketPage />}
        {tab === 'news' && <NewsPage />}
        {tab === 'me' && isParticipant && <PortfolioPage />}
        {tab === 'rank' && <LeaderboardPage />}
        {tab === 'admin' && isAdmin && <AdminPage />}
        {tab === 'login' && <LoginPage />}
      </div>
    </div>
  );
}
