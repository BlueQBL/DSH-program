import { NavLink } from 'react-router-dom'

const links = [
  { to: '/', label: '首页', hint: 'Home', end: true },
  { to: '/about', label: '关于', hint: 'About', end: false },
]

export default function Navbar() {
  return (
    <header className="navbar">
      <div className="navbar-inner container">
        <NavLink to="/" className="brand" end aria-label="回到首页">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">route·漫游</span>
        </NavLink>

        <nav className="nav" aria-label="主导航">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) =>
                isActive ? 'nav-link is-active' : 'nav-link'
              }
            >
              <span className="nav-waypoint" aria-hidden="true" />
              <span className="nav-label">{link.label}</span>
              <span className="nav-hint">{link.hint}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  )
}
