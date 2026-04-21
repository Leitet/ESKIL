// Tiny hash-free path router. Intercepts clicks on internal links and
// matches patterns like /app, /app/c/:cid, /app/c/:cid/controls/:id.

const routes = [];
let onChange = null;

export function route(pattern, handler) {
  // pattern -> /app/c/:cid/controls/:id
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, m => {
    keys.push(m.slice(1));
    return '([^/]+)';
  }).replace(/\//g, '\\/') + '\\/?$');
  routes.push({ pattern, regex, keys, handler });
}

export function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  dispatch();
}

export function dispatch() {
  const path = location.pathname;
  for (const r of routes) {
    const m = path.match(r.regex);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      r.handler(params);
      onChange?.(path);
      return;
    }
  }
  // No match — show a simple not-found.
  const app = document.getElementById('app');
  if (app) app.innerHTML = `
    <div class="page"><h1 class="t-h1">404</h1>
    <p>Sidan hittades inte. <a href="/app" data-link>Till startsidan</a></p></div>`;
}

export function setRouteChangeHandler(cb) { onChange = cb; }

export function startRouter() {
  // Intercept internal link clicks.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('mailto:')) return;
    e.preventDefault();
    navigate(href);
  });
  window.addEventListener('popstate', dispatch);
  dispatch();
}
