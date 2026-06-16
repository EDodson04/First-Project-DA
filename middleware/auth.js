// Simple bearer-token or password auth for the dashboard API
function requireAuth(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return next(); // no password configured = open

  // Check Authorization header: "Bearer <password>"
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7) === password) return next();

  // Check query param (for simple dashboard use)
  if (req.query.token === password) return next();

  // Check cookie
  const cookieToken = (req.headers.cookie || '')
    .split(';')
    .find(c => c.trim().startsWith('gbm_token='));
  if (cookieToken && cookieToken.split('=')[1]?.trim() === password) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

function loginRoute(app) {
  app.post('/api/login', express.json(), (req, res) => {
    const { password } = req.body;
    if (password === process.env.DASHBOARD_PASSWORD) {
      res.json({ token: password });
    } else {
      res.status(401).json({ error: 'Wrong password' });
    }
  });
}

module.exports = { requireAuth, loginRoute };
