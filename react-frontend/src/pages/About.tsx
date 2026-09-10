const stack = [
  { name: 'React', role: '组件化视图框架', detail: '构建导航栏、页面与布局的可复用组件。' },
  { name: 'TypeScript', role: '类型化的 JavaScript', detail: '为组件的 props 与路由结构提供类型约束。' },
  { name: 'React Router', role: '客户端路由', detail: '用 <Routes / <Route> 声明页面路径，用 <NavLink> 高亮当前所在页。' },
  { name: 'Vite', role: '开发与构建工具', detail: '提供快速的开发服务器和可发布的产品构建。' },
]

export default function About() {
  return (
    <section className="page">
      <div className="container">
        <header className="page-head">
          <p className="eyebrow">ABOUT · /about</p>
          <h1 className="page-title">关于本项目</h1>
          <p className="page-lead">
            这是一个最小而完整的 React + TypeScript 应用：一份导航栏、两个页面、
            一条路由表。它演示了 React Router 最基础、也最常用的那部分能力。
          </p>
        </header>

        <div className="about-body">
          <p>
            页面 <code>/</code> 与 <code>/about</code> 都挂在同一个布局下。布局里只有两件事：
            顶部的导航栏和承载页面内容的出口 <code>&lt;Outlet /&gt;</code>。无论切到哪一页，
            导航栏都不用重新渲染——这是嵌套路由带来的结构收益。
          </p>
          <p>
            导航栏使用 <code>&lt;NavLink&gt;</code>，它会根据当前地址自动标记「所在页」，
            让当前位置在视觉上始终清晰。任何未声明的地址则由 <code>{'*'}</code> 兜底到 404 页。
          </p>
        </div>

        <div className="stack-list">
          {stack.map((item, i) => (
            <div className="stack-row" key={item.name}>
              <span className="stack-index" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="stack-name">{item.name}</div>
              <div className="stack-role">{item.role}</div>
              <p className="stack-detail">{item.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
