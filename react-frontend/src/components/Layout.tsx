import { Outlet } from 'react-router-dom'
import Navbar from './Navbar'

export default function Layout() {
  return (
    <div className="shell">
      <Navbar />
      <main className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <div className="container footer-inner">
          <span className="footer-mark" aria-hidden="true" />
          <span>route·漫游 — 一个 React Router 演示</span>
          <span className="footer-tech">React · TypeScript · react-router-dom</span>
        </div>
      </footer>
    </div>
  )
}
