const express = require("express");
const crypto = require("crypto");
const { db, normalizeEmail, slugColor, withTransaction } = require("./db");
const { adminEmail, sendFamilyApprovalEmail } = require("./email");

function createApiRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required." });
    next();
  });

  router.get("/me", (req, res) => {
    const families = db.prepare(`
      select f.id, f.name, fm.role
      from families f
      join family_members fm on fm.family_id = f.id
      where fm.user_id = ?
      order by f.created_at asc
    `).all(req.user.id);

    const kidLinks = db.prepare(`
      select k.id, k.name, k.family_id
      from kids k
      where k.linked_user_id = ?
      order by k.created_at asc
    `).all(req.user.id);

    const pendingFamilyRequests = db.prepare(`
      select id, requester_email as requesterEmail, status, requested_at as requestedAt, expires_at as expiresAt
      from family_approval_requests
      where requester_user_id = ? and status = 'pending'
      order by requested_at desc
    `).all(req.user.id);

    res.json({
      user: publicUser(req.user),
      families,
      kidLinks,
      pendingFamilyRequests,
      needsOnboarding: families.length === 0 && kidLinks.length === 0 && pendingFamilyRequests.length === 0,
      awaitingFamilyApproval: families.length === 0 && kidLinks.length === 0 && pendingFamilyRequests.length > 0
    });
  });

  router.post("/onboarding", async (req, res, next) => {
    try {
      const setup = normalizeFamilySetup(req.body);
      if (!approvalRequired()) {
        const created = withTransaction(() => createFamilyRows(req.user.id, setup));
        res.status(201).json(created);
        return;
      }

      const existing = db.prepare(`
        select id, expires_at from family_approval_requests
        where requester_user_id = ? and status = 'pending' and expires_at > datetime('now')
        order by requested_at desc
      `).get(req.user.id);
      if (existing) {
        res.status(202).json({ pendingApproval: true, requestId: existing.id, expiresAt: existing.expires_at });
        return;
      }

      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + approvalTtlHours() * 60 * 60 * 1000).toISOString();
      const request = db.prepare(`
        insert into family_approval_requests
          (requester_user_id, requester_email, requester_name, token_hash, setup_json, expires_at)
        values (?, ?, ?, ?, ?, ?)
      `).run(req.user.id, req.user.email, req.user.name, tokenHash, JSON.stringify(setup), expiresAt);
      const approvalUrl = `${appBaseUrl()}/admin/family-requests/${token}/approve`;

      try {
        await sendFamilyApprovalEmail({
          requester: { name: req.user.name, email: req.user.email },
          familyName: setup.familyName,
          kidName: setup.kidName,
          approvalUrl,
          expiresAt
        });
      } catch (error) {
        db.prepare("delete from family_approval_requests where id = ?").run(request.lastInsertRowid);
        throw error;
      }

      res.status(202).json({ pendingApproval: true, requestId: request.lastInsertRowid, expiresAt });
    } catch (error) {
      next(error);
    }
  });

  router.get("/families/:familyId/kids", (req, res) => {
    const membership = requireFamily(req, res, req.params.familyId);
    if (!membership) return;
    const kids = membership.role === "parent"
      ? db.prepare("select * from kids where family_id = ? order by created_at asc").all(membership.familyId)
      : db.prepare("select * from kids where family_id = ? and linked_user_id = ? order by created_at asc").all(membership.familyId, req.user.id);
    res.json({ kids });
  });

  router.post("/families/:familyId/kids", (req, res) => {
    const membership = requireParent(req, res, req.params.familyId);
    if (!membership) return;
    const name = cleanText(req.body.name, "Learner");
    const linkedEmail = normalizeEmail(req.body.linkedEmail);
    const weeklyMinutes = clampInt(req.body.weeklyMinutes, 30, 10080);
    const weekdayMinutes = clampInt(req.body.weekdayMinutes, 5, 1440);
    const weekendMinutes = clampInt(req.body.weekendMinutes, 5, 1440);
    const subjects = normalizeSubjects(req.body.subjects);

    const create = withTransaction(() => {
      const kid = db.prepare("insert into kids (family_id, name, linked_email) values (?, ?, ?)").run(membership.familyId, name, linkedEmail || null);
      subjects.forEach((subject, index) => {
        db.prepare("insert into subjects (kid_id, name, color) values (?, ?, ?)").run(kid.lastInsertRowid, subject, slugColor(index));
      });
      db.prepare("insert into goals (kid_id, weekly_minutes, weekday_minutes, weekend_minutes) values (?, ?, ?, ?)").run(
        kid.lastInsertRowid,
        weeklyMinutes,
        weekdayMinutes,
        weekendMinutes
      );
      db.prepare("insert into prizes (kid_id) values (?)").run(kid.lastInsertRowid);
      return kid.lastInsertRowid;
    });

    res.status(201).json({ kidId: create });
  });

  router.get("/kids/:kidId/dashboard", (req, res) => {
    const access = requireKidAccess(req, res, req.params.kidId);
    if (!access) return;
    res.json(buildDashboard(access.kidId, access.role));
  });

  router.post("/kids/:kidId/subjects", (req, res) => {
    const access = requireKidParent(req, res, req.params.kidId);
    if (!access) return;
    const name = cleanText(req.body.name, "");
    if (!name) return res.status(400).json({ error: "Subject name is required." });
    const color = cleanText(req.body.color, slugColor(Date.now()));
    const result = db.prepare("insert into subjects (kid_id, name, color) values (?, ?, ?)").run(access.kidId, name, color);
    res.status(201).json({ subjectId: result.lastInsertRowid });
  });

  router.put("/subjects/:subjectId", (req, res) => {
    const subject = db.prepare("select * from subjects where id = ?").get(req.params.subjectId);
    if (!subject) return res.status(404).json({ error: "Subject not found." });
    const access = requireKidParent(req, res, subject.kid_id);
    if (!access) return;
    const name = cleanText(req.body.name, subject.name);
    const color = cleanText(req.body.color, subject.color);
    db.prepare("update subjects set name = ?, color = ? where id = ?").run(name, color, subject.id);
    res.json({ ok: true });
  });

  router.put("/kids/:kidId/goals", (req, res) => {
    const access = requireKidParent(req, res, req.params.kidId);
    if (!access) return;
    db.prepare(`
      insert into goals (kid_id, weekly_minutes, weekday_minutes, weekend_minutes, updated_at)
      values (?, ?, ?, ?, current_timestamp)
      on conflict(kid_id) do update set
        weekly_minutes = excluded.weekly_minutes,
        weekday_minutes = excluded.weekday_minutes,
        weekend_minutes = excluded.weekend_minutes,
        updated_at = current_timestamp
    `).run(
      access.kidId,
      clampInt(req.body.weeklyMinutes, 30, 10080),
      clampInt(req.body.weekdayMinutes, 5, 1440),
      clampInt(req.body.weekendMinutes, 5, 1440)
    );
    res.json({ ok: true });
  });

  router.put("/kids/:kidId/prize", (req, res) => {
    const access = requireKidParent(req, res, req.params.kidId);
    if (!access) return;
    const prize = normalizePrize(req.body);
    db.prepare(`
      insert into prizes (kid_id, name, target_date, target_weeks, success_percent, updated_at)
      values (?, ?, ?, ?, ?, current_timestamp)
      on conflict(kid_id) do update set
        name = excluded.name,
        target_date = excluded.target_date,
        target_weeks = excluded.target_weeks,
        success_percent = excluded.success_percent,
        updated_at = current_timestamp
    `).run(access.kidId, prize.name, prize.targetDate, prize.targetWeeks, prize.successPercent);
    res.json({ ok: true });
  });

  router.post("/kids/:kidId/sessions", (req, res) => {
    const access = requireKidParent(req, res, req.params.kidId);
    if (!access) return;
    const subject = db.prepare("select * from subjects where id = ? and kid_id = ?").get(req.body.subjectId, access.kidId);
    if (!subject) return res.status(400).json({ error: "Valid subject is required." });
    const session = normalizeSession(req.body);
    const result = db.prepare(`
      insert into study_sessions
        (kid_id, subject_id, minutes, performance_percent, correct, total, note, source, session_date, created_by_user_id)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      access.kidId,
      subject.id,
      session.minutes,
      session.performancePercent,
      session.correct,
      session.total,
      session.note,
      session.source,
      session.sessionDate,
      req.user.id
    );
    res.status(201).json({ sessionId: result.lastInsertRowid });
  });

  router.post("/kids/:kidId/import-local-sessions", (req, res) => {
    const access = requireKidParent(req, res, req.params.kidId);
    if (!access) return;
    const sourceKey = cleanText(req.body.sourceKey, "mathQuestTracker.sessions.v1");
    const oldSessions = Array.isArray(req.body.sessions) ? req.body.sessions : [];
    if (!oldSessions.length) return res.status(400).json({ error: "No sessions to import." });
    const importedBefore = db.prepare("select id from import_events where kid_id = ? and source_key = ?").get(access.kidId, sourceKey);
    if (importedBefore) return res.status(409).json({ error: "This data was already imported for the selected kid." });

    const count = withTransaction(() => {
      let mathSubject = db.prepare("select * from subjects where kid_id = ? and lower(name) = 'math'").get(access.kidId);
      if (!mathSubject) {
        const subject = db.prepare("insert into subjects (kid_id, name, color) values (?, 'Math', '#60a5fa')").run(access.kidId);
        mathSubject = { id: subject.lastInsertRowid };
      }
      let imported = 0;
      oldSessions.forEach((entry) => {
        const minutes = clampInt(entry.minutes, 1, 1440);
        const percent = entry.percent === undefined ? null : clampInt(entry.percent, 0, 100);
        const correct = entry.correct === undefined ? null : clampInt(entry.correct, 0, 10000);
        const total = entry.problems === undefined ? null : clampInt(entry.problems, 1, 10000);
        const date = validDate(entry.date) ? new Date(entry.date).toISOString() : new Date().toISOString();
        db.prepare(`
          insert into study_sessions
            (kid_id, subject_id, minutes, performance_percent, correct, total, note, source, session_date, created_by_user_id)
          values (?, ?, ?, ?, ?, ?, ?, 'migrated', ?, ?)
        `).run(access.kidId, mathSubject.id, minutes, percent, correct, total, cleanText(entry.note, ""), date, req.user.id);
        imported += 1;
      });
      db.prepare(`
        insert into import_events (kid_id, source_key, imported_by_user_id, imported_count)
        values (?, ?, ?, ?)
      `).run(access.kidId, sourceKey, req.user.id, imported);
      return imported;
    });

    res.status(201).json({ imported: count });
  });

  router.post("/families/:familyId/parent-invites", (req, res) => {
    const membership = requireParent(req, res, req.params.familyId);
    if (!membership) return;
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: "Email is required." });
    db.prepare(`
      insert into parent_invites (family_id, email, invited_by_user_id)
      values (?, ?, ?)
      on conflict(family_id, email) do update set invited_by_user_id = excluded.invited_by_user_id
    `).run(membership.familyId, email, req.user.id);
    const invitedUser = db.prepare("select * from users where email = ?").get(email);
    if (invitedUser) {
      db.prepare("insert or ignore into family_members (family_id, user_id, role) values (?, ?, 'parent')").run(membership.familyId, invitedUser.id);
      db.prepare("update parent_invites set accepted_at = current_timestamp where family_id = ? and email = ?").run(membership.familyId, email);
    }
    res.status(201).json({ ok: true });
  });

  return router;
}

function createApprovalRouter() {
  const router = express.Router();

  router.get("/family-requests/:token/approve", (req, res, next) => {
    try {
      const token = req.params.token;
      const admin = adminEmail.toLowerCase();
      if (!req.user || normalizeEmail(req.user.email) !== admin) {
        req.session.pendingApprovalToken = token;
        req.session.save(() => res.redirect("/auth/google"));
        return;
      }

      const request = db.prepare(`
        select * from family_approval_requests
        where token_hash = ? and status = 'pending'
      `).get(hashToken(token));

      if (!request) {
        res.status(404).send(renderApprovalPage("Request not found", "This approval link is invalid, already used, or no longer pending."));
        return;
      }

      if (new Date(request.expires_at) <= new Date()) {
        db.prepare(`
          update family_approval_requests
          set status = 'expired', decided_at = current_timestamp, decided_by_email = ?
          where id = ?
        `).run(req.user.email, request.id);
        res.status(410).send(renderApprovalPage("Request expired", "Ask the family to submit onboarding again."));
        return;
      }

      const setup = JSON.parse(request.setup_json);
      const created = withTransaction(() => {
        const rows = createFamilyRows(request.requester_user_id, setup);
        db.prepare(`
          update family_approval_requests
          set status = 'approved', decided_at = current_timestamp, decided_by_email = ?
          where id = ?
        `).run(req.user.email, request.id);
        return rows;
      });

      res.send(renderApprovalPage(
        "Family approved",
        `${setup.familyName} is ready. Family ID ${created.familyId}, kid ID ${created.kidId}.`
      ));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function requireFamily(req, res, familyId) {
  const membership = db.prepare(`
    select family_id as familyId, role from family_members
    where user_id = ? and family_id = ?
  `).get(req.user.id, Number(familyId));
  if (!membership) {
    res.status(403).json({ error: "Family access denied." });
    return null;
  }
  return membership;
}

function requireParent(req, res, familyId) {
  const membership = requireFamily(req, res, familyId);
  if (!membership) return null;
  if (membership.role !== "parent") {
    res.status(403).json({ error: "Parent access required." });
    return null;
  }
  return membership;
}

function requireKidAccess(req, res, kidId) {
  const kid = db.prepare("select * from kids where id = ?").get(Number(kidId));
  if (!kid) {
    res.status(404).json({ error: "Kid not found." });
    return null;
  }
  const membership = db.prepare(`
    select role from family_members where family_id = ? and user_id = ?
  `).get(kid.family_id, req.user.id);
  if (!membership) {
    res.status(403).json({ error: "Kid access denied." });
    return null;
  }
  if (membership.role === "kid" && kid.linked_user_id !== req.user.id) {
    res.status(403).json({ error: "Kid access denied." });
    return null;
  }
  return { kidId: kid.id, familyId: kid.family_id, role: membership.role };
}

function requireKidParent(req, res, kidId) {
  const access = requireKidAccess(req, res, kidId);
  if (!access) return null;
  if (access.role !== "parent") {
    res.status(403).json({ error: "Parent access required." });
    return null;
  }
  return access;
}

function buildDashboard(kidId, role) {
  const kid = db.prepare("select * from kids where id = ?").get(kidId);
  const subjects = db.prepare("select * from subjects where kid_id = ? order by created_at asc").all(kidId);
  const goals = db.prepare("select * from goals where kid_id = ?").get(kidId) || { weekly_minutes: 300, weekday_minutes: 45, weekend_minutes: 30 };
  const prize = db.prepare("select * from prizes where kid_id = ?").get(kidId) || {};
  const sessions = db.prepare(`
    select s.*, sub.name as subject_name, sub.color as subject_color
    from study_sessions s
    join subjects sub on sub.id = s.subject_id
    where s.kid_id = ?
    order by s.session_date desc, s.id desc
  `).all(kidId);

  const todayKey = dateKey(new Date());
  const weekStart = startOfWeek(new Date());
  const todayMinutes = sessions
    .filter((session) => dateKey(session.session_date) === todayKey)
    .reduce((sum, session) => sum + session.minutes, 0);
  const weeklyMinutes = sessions
    .filter((session) => new Date(session.session_date) >= weekStart)
    .reduce((sum, session) => sum + session.minutes, 0);
  const target = isWeekend(new Date()) ? goals.weekend_minutes : goals.weekday_minutes;
  const energyPercent = Math.round((todayMinutes / Math.max(1, target)) * 100);
  const streak = calculateStreak(sessions);
  const subjectStats = subjects.map((subject) => buildSubjectStats(subject, sessions));

  return {
    role,
    kid,
    subjects,
    goals: {
      weeklyMinutes: goals.weekly_minutes,
      weekdayMinutes: goals.weekday_minutes,
      weekendMinutes: goals.weekend_minutes
    },
    prize: {
      name: prize.name || "",
      targetDate: prize.target_date || "",
      targetWeeks: prize.target_weeks || "",
      successPercent: prize.success_percent || 100
    },
    summary: {
      todayMinutes,
      todayTargetMinutes: target,
      energyPercent,
      energyZone: energyPercent >= 100 ? "green" : energyPercent >= 50 ? "yellow" : "red",
      weeklyMinutes,
      weeklyTargetMinutes: goals.weekly_minutes,
      streak,
      totalSessions: sessions.length,
      averagePerformance: average(sessions.map((session) => session.performance_percent).filter((value) => value !== null))
    },
    subjectStats,
    rewards: buildRewards(sessions, subjectStats, {
      todayMinutes,
      todayTarget: target,
      weeklyMinutes,
      weeklyTarget: goals.weekly_minutes,
      streak,
      prize
    }),
    sessions: sessions.slice(0, 25)
  };
}

function buildSubjectStats(subject, sessions) {
  const related = sessions.filter((session) => session.subject_id === subject.id);
  const scored = related.map((session) => session.performance_percent).filter((value) => value !== null);
  const latest = related[0] || null;
  return {
    id: subject.id,
    name: subject.name,
    color: subject.color,
    minutes: related.reduce((sum, session) => sum + session.minutes, 0),
    sessions: related.length,
    latestPerformance: latest ? latest.performance_percent : null,
    averagePerformance: average(scored)
  };
}

function buildRewards(sessions, subjectStats, progress) {
  const scored = sessions.filter((session) => session.performance_percent !== null);
  const improved = scored.some((session, index) => index < scored.length - 1 && session.performance_percent > scored[index + 1].performance_percent);
  const prizeThreshold = progress.weeklyTarget * ((progress.prize.success_percent || 100) / 100);
  return [
    { title: "First Step", desc: "Complete the first tutoring session.", unlocked: sessions.length >= 1 },
    { title: "Green Energy", desc: "Reach today’s learning target.", unlocked: progress.todayMinutes >= progress.todayTarget },
    { title: "Three-Day Lane", desc: "Study three days in a row.", unlocked: progress.streak >= 3 },
    { title: "Weekly Win", desc: "Meet the weekly hour goal.", unlocked: progress.weeklyMinutes >= progress.weeklyTarget },
    { title: "Subject Explorer", desc: "Practice three different subjects.", unlocked: subjectStats.filter((subject) => subject.sessions > 0).length >= 3 },
    { title: "Better Than Before", desc: "Improve a practice performance score.", unlocked: improved },
    { title: "Prize Ready", desc: "Reach the prize success threshold.", unlocked: Boolean(progress.prize.name) && progress.weeklyMinutes >= prizeThreshold }
  ];
}

function normalizeFamilySetup(body) {
  return {
    familyName: cleanText(body.familyName, "Family"),
    kidName: cleanText(body.kidName, "Learner"),
    linkedEmail: normalizeEmail(body.kidEmail),
    weeklyMinutes: clampInt(body.weeklyMinutes, 30, 10080),
    weekdayMinutes: clampInt(body.weekdayMinutes, 5, 1440),
    weekendMinutes: clampInt(body.weekendMinutes, 5, 1440),
    subjects: normalizeSubjects(body.subjects),
    prize: normalizePrize(body.prize || {})
  };
}

function createFamilyRows(userId, setup) {
  const family = db.prepare("insert into families (name, creator_user_id) values (?, ?)").run(setup.familyName, userId);
  db.prepare("insert into family_members (family_id, user_id, role) values (?, ?, 'parent')").run(family.lastInsertRowid, userId);
  const kid = db.prepare("insert into kids (family_id, name, linked_email) values (?, ?, ?)").run(
    family.lastInsertRowid,
    setup.kidName,
    setup.linkedEmail || null
  );
  setup.subjects.forEach((subject, index) => {
    db.prepare("insert into subjects (kid_id, name, color) values (?, ?, ?)").run(kid.lastInsertRowid, subject, slugColor(index));
  });
  db.prepare("insert into goals (kid_id, weekly_minutes, weekday_minutes, weekend_minutes) values (?, ?, ?, ?)").run(
    kid.lastInsertRowid,
    setup.weeklyMinutes,
    setup.weekdayMinutes,
    setup.weekendMinutes
  );
  db.prepare("insert into prizes (kid_id, name, target_date, target_weeks, success_percent) values (?, ?, ?, ?, ?)").run(
    kid.lastInsertRowid,
    setup.prize.name,
    setup.prize.targetDate,
    setup.prize.targetWeeks,
    setup.prize.successPercent
  );
  return { familyId: family.lastInsertRowid, kidId: kid.lastInsertRowid };
}

function approvalRequired() {
  return process.env.FAMILY_APPROVAL_REQUIRED !== "false";
}

function approvalTtlHours() {
  return clampInt(process.env.FAMILY_APPROVAL_TTL_HOURS || 72, 1, 24 * 14);
}

function appBaseUrl() {
  return String(process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function renderApprovalPage(title, message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} | Learning Lane</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff1f7; color: #43263b; font-family: system-ui, sans-serif; }
      main { width: min(520px, calc(100% - 32px)); border: 2px solid #ffc7df; border-radius: 8px; background: #fff; padding: 28px; box-shadow: 0 16px 34px rgba(219,39,119,.14); }
      h1 { color: #9d174d; margin-top: 0; }
      a { color: #db2777; font-weight: 800; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <a href="/">Back to Learning Lane</a>
    </main>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function normalizeSubjects(subjects) {
  const values = Array.isArray(subjects) ? subjects : String(subjects || "Math, English, Science").split(",");
  const clean = [...new Set(values.map((name) => cleanText(name, "")).filter(Boolean))];
  return clean.length ? clean.slice(0, 12) : ["Math", "English", "Science"];
}

function normalizePrize(prize) {
  return {
    name: cleanText(prize.name, ""),
    targetDate: cleanText(prize.targetDate, "") || null,
    targetWeeks: prize.targetWeeks ? clampInt(prize.targetWeeks, 1, 260) : null,
    successPercent: clampInt(prize.successPercent, 1, 100)
  };
}

function normalizeSession(body) {
  const correct = body.correct === "" || body.correct === undefined ? null : clampInt(body.correct, 0, 10000);
  const total = body.total === "" || body.total === undefined ? null : clampInt(body.total, 1, 10000);
  const providedPercent = body.performancePercent === "" || body.performancePercent === undefined ? null : clampInt(body.performancePercent, 0, 100);
  const computedPercent = correct !== null && total !== null ? Math.round((Math.min(correct, total) / total) * 100) : null;
  const source = ["timer", "manual", "migrated"].includes(body.source) ? body.source : "manual";
  return {
    minutes: clampInt(body.minutes, 1, 1440),
    performancePercent: providedPercent !== null ? providedPercent : computedPercent,
    correct,
    total,
    note: cleanText(body.note, ""),
    source,
    sessionDate: validDate(body.sessionDate) ? new Date(body.sessionDate).toISOString() : new Date().toISOString()
  };
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url };
}

function cleanText(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function clampInt(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) return min;
  return Math.min(Math.max(number, min), max);
}

function validDate(value) {
  return value && !Number.isNaN(new Date(value).getTime());
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function startOfWeek(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function dateKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function calculateStreak(sessions) {
  const days = [...new Set(sessions.map((session) => dateKey(session.session_date)))].sort().reverse();
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (const day of days) {
    if (day !== dateKey(cursor)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

module.exports = { createApiRouter, createApprovalRouter };
