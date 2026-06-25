import { useApp } from '../state/AppContext.jsx';

export default function NewsPage() {
  const { stockBoard } = useApp();
  const news = stockBoard?.news || [];
  return (
    <div className="card">
      <h3>📰 뉴스</h3>
      {news.length === 0
        ? <p className="muted">아직 뉴스가 없습니다. 장중 자동 뉴스(랜덤)나 운영자 발표가 여기에 쌓입니다.</p>
        : news.map((n, i) => {
          const up = n.polarity === 'good'; const down = n.polarity === 'bad';
          return (
            <div className="news-item" key={i}>
              {(up || down) && <span className={up ? 'up' : 'down'} style={{ fontWeight: 700, marginRight: 6 }}>{up ? '▲' : '▼'}</span>}
              {n.badge && <span className="co-tag" style={{ marginRight: 6 }}>{n.badge}</span>}
              {n.text}
              <span className="when"> · {new Date(n.at).toLocaleString('ko-KR')}</span>
            </div>
          );
        })}
    </div>
  );
}
