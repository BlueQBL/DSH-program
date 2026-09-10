import { Link } from 'react-router-dom'

const cards = [
  {
    path: '/',
    title: '首页',
    body: '起点。浏览这个演示的概览，看看 React Router 如何让页面在地址栏之间来回穿梭。',
  },
  {
    path: '/about',
    title: '关于',
    body: '第二站。关于本项目的说明与它使用的技术栈。',
  },
  {
    path: '*',
    title: '未知路径',
    body: '兜底。访问任何没有声明的地址，都会被优雅地引导回来，而不是空白页面。',
  },
]

export default function Home() {
  return (
    <section className="page">
      <div className="container">
        <div className="hero">
          <p className="eyebrow">REACT · TYPESCRIPT · REACT ROUTER</p>
          <h1 className="hero-title">
            一条路径，
            <br />
            两处风景
          </h1>
          <p className="hero-sub">
            顶部的导航栏始终在场。在「首页」与「关于」之间点击切换，
            URL 随之改变，页面随路由更换——这正是 React Router 在做的事。
          </p>

          <figure className="routemap" aria-label="路由示意：/ 通往 /about">
            <svg viewBox="0 0 560 120" role="img" aria-hidden="true" focusable="false">
              <defs>
                <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
                  <circle cx="28" cy="0" r="1.1" fill="rgba(143,163,191,0.22)" />
                  <circle cx="0" cy="28" r="1.1" fill="rgba(143,163,191,0.22)" />
                </pattern>
              </defs>
              <rect width="560" height="120" fill="url(#grid)" rx="16" />
              <path
                className="route-track"
                d="M 150 60 H 410"
                fill="none"
                stroke="rgba(143,163,191,0.35)"
                strokeWidth="2"
                strokeDasharray="2 8"
              />
              <path
                className="route-path"
                d="M 150 60 H 410"
                fill="none"
                stroke="#5AD1F5"
                strokeWidth="2"
                strokeDasharray="6 7"
              />
              <g className="route-node">
                <circle cx="150" cy="60" r="20" fill="#131E33" stroke="#8B7CF6" strokeWidth="2" />
                <circle cx="150" cy="60" r="7" fill="#8B7CF6" />
              </g>
              <g className="route-node">
                <circle cx="410" cy="60" r="20" fill="#131E33" stroke="#8B7CF6" strokeWidth="2" />
                <circle cx="410" cy="60" r="7" fill="#8B7CF6" />
              </g>
              <text x="150" y="92" textAnchor="middle" className="route-label">{'/'}</text>
              <text x="410" y="92" textAnchor="middle" className="route-label">{'/about'}</text>
              <text x="280" y="30" textAnchor="middle" className="route-caption">点击导航栏即可通行</text>
            </svg>
          </figure>
        </div>

        <div className="card-grid">
          {cards.map((card) => (
            <article className="card" key={card.path}>
              <div className="card-path">
                <span className="card-node" aria-hidden="true" />
                <code>{card.path}</code>
              </div>
              <h2 className="card-title">{card.title}</h2>
              <p className="card-body">{card.body}</p>
              <Link to={card.path} className="card-link">
                前往 {card.title} <span aria-hidden="true">→</span>
              </Link>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
