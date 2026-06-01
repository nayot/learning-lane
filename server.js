require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { db, ensureDatabase, findOrCreateUser, hydrateLinkedKidAccounts } = require("./src/db");
const { createApiRouter, createApprovalRouter } = require("./src/routes");

ensureDatabase();

const app = express();
const port = Number(process.env.PORT || 3000);
const mountPath = (process.env.MOUNT_PATH || "").replace(/\/$/, "");

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = db.prepare("select sess from web_sessions where sid = ? and expires > ?").get(sid, Date.now());
      callback(null, row ? JSON.parse(row.sess) : null);
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback) {
    try {
      const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.prepare(`
        insert into web_sessions (sid, sess, expires)
        values (?, ?, ?)
        on conflict(sid) do update set sess = excluded.sess, expires = excluded.expires
      `).run(sid, JSON.stringify(sess), expires);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      db.prepare("delete from web_sessions where sid = ?").run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    store: new SQLiteSessionStore(),
    secret: process.env.SESSION_SECRET || "dev-only-change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 14
    }
  })
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare("select * from users where id = ?").get(id);
    done(null, user || false);
  } catch (error) {
    done(error);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID || "missing-client-id",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "missing-client-secret",
      callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/google/callback"
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : "";
        if (!email) return done(new Error("Google account did not provide an email address."));
        const user = findOrCreateUser({
          googleId: profile.id,
          email,
          name: profile.displayName || email,
          avatarUrl: profile.photos && profile.photos[0] ? profile.photos[0].value : ""
        });
        hydrateLinkedKidAccounts(user);
        done(null, user);
      } catch (error) {
        done(error);
      }
    }
  )
);

app.use(passport.initialize());
app.use(passport.session());

app.get(`${mountPath}/auth/google`, (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(500).send("Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    return;
  }
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get(
  `${mountPath}/auth/google/callback`,
  passport.authenticate("google", { failureRedirect: `${mountPath}/?login=failed` }),
  (req, res) => {
    if (req.session.pendingApprovalToken) {
      const token = req.session.pendingApprovalToken;
      delete req.session.pendingApprovalToken;
      res.redirect(`${mountPath}/admin/family-requests/${encodeURIComponent(token)}/approve`);
      return;
    }
    res.redirect(`${mountPath}/`);
  }
);

app.post(`${mountPath}/auth/logout`, (req, res, next) => {
  req.logout((error) => {
    if (error) return next(error);
    res.json({ ok: true });
  });
});

app.use(`${mountPath}/api`, createApiRouter());
app.use(`${mountPath}/admin`, createApprovalRouter());

const rawIndexHtml = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const indexHtml = mountPath
  ? rawIndexHtml.replace("<head>", `<head>\n    <base href="${mountPath}/">\n    <meta name="mount-path" content="${mountPath}">`)
  : rawIndexHtml;
app.get([mountPath || "/", `${mountPath}/`].filter(Boolean), (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(indexHtml);
});
app.use(mountPath || "/", express.static(path.join(__dirname, "public"), { index: false }));

app.use((error, req, res, next) => {
  console.error(error);
  const message = process.env.NODE_ENV === "production" ? "Request failed." : error.message;
  if (req.path.startsWith(`${mountPath}/api`)) {
    res.status(500).json({ error: message });
    return;
  }
  res.status(500).send(message);
});

app.listen(port, () => {
  console.log(`Learning Lane listening on http://localhost:${port}`);
});
