import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <section className="page">
      <div className="container notfound">
        <p className="notfound-code">404</p>
        <h1 className="page-title">此路不通</h1>
        <p className="notfound-body">
          这个地址没有被注册到任何页面。地址栏也许拼错了；
          不妨回到首页，从导航栏重新出发。
        </p>
        <Link to="/" className="btn">
          回到首页 <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  )
}
