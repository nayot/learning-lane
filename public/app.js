const MOUNT_PATH = document.querySelector('meta[name="mount-path"]')?.content ?? "";

const state = {
  me: null,
  dashboard: null,
  selectedFamilyId: null,
  selectedKidId: Number(localStorage.getItem("learningLane.selectedKidId")) || null,
  timer: {
    interval: null,
    startedAt: null,
    elapsedSeconds: 0
  }
};

const $ = (selector) => document.querySelector(selector);
const oldStorageKey = "mathQuestTracker.sessions.v1";

const els = {
  loginView: $("#loginView"),
  onboardingView: $("#onboardingView"),
  pendingApprovalView: $("#pendingApprovalView"),
  pendingApprovalText: $("#pendingApprovalText"),
  pendingRefreshButton: $("#pendingRefreshButton"),
  appView: $("#appView"),
  onboardingForm: $("#onboardingForm"),
  kidTitle: $("#kidTitle"),
  kidSelect: $("#kidSelect"),
  logoutButton: $("#logoutButton"),
  energyText: $("#energyText"),
  energyFill: $("#energyFill"),
  energyHint: $("#energyHint"),
  laneMarker: $("#laneMarker"),
  weeklyRing: $("#weeklyRing"),
  weeklyRingText: $("#weeklyRingText"),
  scoreRing: $("#scoreRing"),
  scoreRingText: $("#scoreRingText"),
  weeklyText: $("#weeklyText"),
  streakText: $("#streakText"),
  streakBadgeText: $("#streakBadgeText"),
  streakHearts: $("#streakHearts"),
  streakHintText: $("#streakHintText"),
  scoreText: $("#scoreText"),
  parentTools: $("#parentTools"),
  parentSettings: $("#parentSettings"),
  manualForm: $("#manualForm"),
  manualSubject: $("#manualSubject"),
  manualMinutes: $("#manualMinutes"),
  manualPercent: $("#manualPercent"),
  manualNote: $("#manualNote"),
  timerForm: $("#timerForm"),
  timerSubject: $("#timerSubject"),
  timerMinutes: $("#timerMinutes"),
  timerDisplay: $("#timerDisplay"),
  startTimer: $("#startTimer"),
  stopTimer: $("#stopTimer"),
  saveTimer: $("#saveTimer"),
  goalForm: $("#goalForm"),
  goalWeekly: $("#goalWeekly"),
  goalWeekday: $("#goalWeekday"),
  goalWeekend: $("#goalWeekend"),
  subjectForm: $("#subjectForm"),
  subjectName: $("#subjectName"),
  subjectColor: $("#subjectColor"),
  parentInviteForm: $("#parentInviteForm"),
  parentEmail: $("#parentEmail"),
  importPanel: $("#importPanel"),
  importButton: $("#importButton"),
  subjectList: $("#subjectList"),
  subjectStaminaChart: $("#subjectStaminaChart"),
  subjectSkillChart: $("#subjectSkillChart"),
  prizeForm: $("#prizeForm"),
  editPrizeName: $("#editPrizeName"),
  editTargetDate: $("#editTargetDate"),
  savePrizeButton: $("#savePrizeButton"),
  prizeText: $("#prizeText"),
  rewardList: $("#rewardList"),
  historyList: $("#historyList"),
  toast: $("#toast")
};

init();

async function init() {
  bindEvents();
  try {
    state.me = await api("/api/me");
    if (state.me.needsOnboarding) {
      showOnly(els.onboardingView);
      return;
    }
    if (state.me.awaitingFamilyApproval) {
      renderPendingApproval();
      showOnly(els.pendingApprovalView);
      return;
    }
    await loadFamilyAndKid();
  } catch (error) {
    showOnly(els.loginView);
  }
}

function bindEvents() {
  els.onboardingForm.addEventListener("submit", submitOnboarding);
  els.pendingRefreshButton.addEventListener("click", init);
  els.kidSelect.addEventListener("change", () => {
    state.selectedKidId = Number(els.kidSelect.value);
    localStorage.setItem("learningLane.selectedKidId", String(state.selectedKidId));
    loadDashboard();
  });
  els.logoutButton.addEventListener("click", logout);
  els.manualForm.addEventListener("submit", submitManualSession);
  els.startTimer.addEventListener("click", startTimer);
  els.stopTimer.addEventListener("click", stopTimer);
  els.saveTimer.addEventListener("click", saveTimerSession);
  els.goalForm.addEventListener("submit", submitGoals);
  els.subjectForm.addEventListener("submit", submitSubject);
  els.parentInviteForm.addEventListener("submit", submitParentInvite);
  els.prizeForm.addEventListener("submit", submitPrize);
  els.importButton.addEventListener("click", importOldSessions);
}

async function submitOnboarding(event) {
  event.preventDefault();
  const payload = {
    familyName: $("#familyName").value,
    kidName: $("#kidName").value,
    kidEmail: $("#kidEmail").value,
    weeklyMinutes: $("#weeklyMinutes").value,
    weekdayMinutes: $("#weekdayMinutes").value,
    weekendMinutes: $("#weekendMinutes").value,
    subjects: $("#initialSubjects").value.split(",").map((value) => value.trim()),
    prize: {
      name: $("#prizeName").value,
      targetDate: $("#targetDate").value,
      successPercent: $("#successPercent").value
    }
  };
  const result = await api("/api/onboarding", { method: "POST", body: payload });
  if (result.pendingApproval) {
    state.me = await api("/api/me");
    renderPendingApproval(result.expiresAt);
    showOnly(els.pendingApprovalView);
    toast("Approval request sent.");
    return;
  }
  state.selectedKidId = result.kidId;
  localStorage.setItem("learningLane.selectedKidId", String(result.kidId));
  state.me = await api("/api/me");
  await loadFamilyAndKid();
  toast("Family created.");
}

function renderPendingApproval(expiresAt) {
  const pending = state.me && state.me.pendingFamilyRequests ? state.me.pendingFamilyRequests[0] : null;
  const expiry = expiresAt || (pending ? pending.expiresAt : "");
  els.pendingApprovalText.textContent = expiry
    ? `Your family setup is waiting for approval until ${formatDate(expiry)}.`
    : "Your family setup is waiting for administrator approval.";
}

async function loadFamilyAndKid() {
  state.selectedFamilyId = state.me.families[0] ? state.me.families[0].id : null;
  if (!state.selectedFamilyId && state.me.kidLinks[0]) {
    state.selectedKidId = state.me.kidLinks[0].id;
    await loadDashboard();
    return;
  }
  const response = await api(`/api/families/${state.selectedFamilyId}/kids`);
  renderKidOptions(response.kids);
  if (!state.selectedKidId || !response.kids.some((kid) => kid.id === state.selectedKidId)) {
    state.selectedKidId = response.kids[0] ? response.kids[0].id : null;
  }
  await loadDashboard();
}

function renderKidOptions(kids) {
  els.kidSelect.innerHTML = "";
  kids.forEach((kid) => {
    const option = document.createElement("option");
    option.value = kid.id;
    option.textContent = kid.name;
    option.selected = kid.id === state.selectedKidId;
    els.kidSelect.append(option);
  });
}

async function loadDashboard() {
  if (!state.selectedKidId) return;
  state.dashboard = await api(`/api/kids/${state.selectedKidId}/dashboard`);
  showOnly(els.appView);
  renderDashboard();
}

function renderDashboard() {
  const dashboard = state.dashboard;
  const parentMode = dashboard.role === "parent";
  const summary = dashboard.summary;
  els.kidTitle.textContent = `${dashboard.kid.name}'s Learning Lane`;
  els.parentTools.hidden = !parentMode;
  els.parentSettings.hidden = !parentMode;
  els.prizeForm.hidden = !parentMode;
  els.savePrizeButton.hidden = !parentMode;

  els.energyText.textContent = `${summary.energyPercent}%`;
  els.energyFill.style.width = `${Math.min(summary.energyPercent, 140)}%`;
  els.energyFill.className = summary.energyZone;
  els.energyHint.textContent = `${summary.todayMinutes} / ${summary.todayTargetMinutes} min today`;
  els.weeklyText.textContent = `${summary.weeklyMinutes} / ${summary.weeklyTargetMinutes} min`;
  els.streakText.textContent = `${summary.streak} day${summary.streak === 1 ? "" : "s"}`;
  renderStreak(summary.streak);
  els.scoreText.textContent = summary.averagePerformance === null ? "No scores" : `${summary.averagePerformance}%`;
  renderProgressVisuals(summary);

  els.goalWeekly.value = dashboard.goals.weeklyMinutes;
  els.goalWeekday.value = dashboard.goals.weekdayMinutes;
  els.goalWeekend.value = dashboard.goals.weekendMinutes;
  els.editPrizeName.value = dashboard.prize.name || "";
  els.editTargetDate.value = dashboard.prize.targetDate || "";
  els.prizeText.textContent = dashboard.prize.name
    ? `${dashboard.prize.name}${dashboard.prize.targetDate ? ` by ${formatDate(dashboard.prize.targetDate)}` : ""}`
    : "No long-term prize has been set yet.";

  renderSubjectSelectors(dashboard.subjects);
  renderSubjects(dashboard.subjectStats);
  renderSubjectStaminaChart(dashboard.subjectStats);
  renderSubjectSkillChart(dashboard.subjectStats);
  renderRewards(dashboard.rewards);
  renderHistory(dashboard.sessions);
  els.importPanel.hidden = !parentMode || !localStorage.getItem(oldStorageKey);
}

function renderStreak(streak) {
  els.streakBadgeText.textContent = `${streak} day${streak === 1 ? "" : "s"}`;
  els.streakHintText.textContent = streak
    ? "Keep showing up each day to protect the sparkle."
    : "Log tutoring today to start a streak.";
  els.streakHearts.innerHTML = "";
  const visibleHearts = Math.max(3, Math.min(7, streak || 3));
  for (let index = 0; index < visibleHearts; index += 1) {
    const heart = document.createElement("span");
    heart.textContent = "♥";
    heart.className = index < streak ? "filled" : "";
    els.streakHearts.append(heart);
  }
}

function renderProgressVisuals(summary) {
  const lanePercent = Math.min(100, Math.max(0, summary.energyPercent));
  const weeklyPercent = Math.min(100, Math.round((summary.weeklyMinutes / Math.max(1, summary.weeklyTargetMinutes)) * 100));
  const scorePercent = summary.averagePerformance === null ? 0 : summary.averagePerformance;

  els.laneMarker.style.left = `${lanePercent}%`;
  els.weeklyRing.style.setProperty("--ring", `${weeklyPercent * 3.6}deg`);
  els.weeklyRingText.textContent = `${weeklyPercent}%`;
  els.scoreRing.style.setProperty("--ring", `${scorePercent * 3.6}deg`);
  els.scoreRingText.textContent = summary.averagePerformance === null ? "--" : `${scorePercent}%`;
}

function renderSubjectSelectors(subjects) {
  [els.manualSubject, els.timerSubject].forEach((select) => {
    select.innerHTML = "";
    subjects.forEach((subject) => {
      const option = document.createElement("option");
      option.value = subject.id;
      option.textContent = subject.name;
      select.append(option);
    });
  });
}

function renderSubjects(subjects) {
  els.subjectList.innerHTML = "";
  subjects.forEach((subject) => {
    const item = document.createElement("article");
    item.className = "subject-card";
    item.style.borderColor = subject.color;
    item.innerHTML = `
      <span class="dot" style="background:${subject.color}"></span>
      <strong>${escapeHtml(subject.name)}</strong>
      <small>${subject.minutes} min · ${subject.sessions} session${subject.sessions === 1 ? "" : "s"}</small>
      <small>${subject.averagePerformance === null ? "No score yet" : `${subject.averagePerformance}% average`}</small>
    `;
    els.subjectList.append(item);
  });
}

function renderSubjectStaminaChart(subjects) {
  els.subjectStaminaChart.innerHTML = "";
  if (!subjects.length) {
    els.subjectStaminaChart.innerHTML = '<p class="empty">Add a subject to grow stamina.</p>';
    return;
  }
  const maxMinutes = Math.max(30, ...subjects.map((subject) => subject.minutes));
  subjects.forEach((subject) => {
    const row = document.createElement("article");
    row.className = "chart-row stamina-row";
    const width = Math.max(6, Math.round((subject.minutes / maxMinutes) * 100));
    row.innerHTML = `
      <span>${escapeHtml(subject.name)}</span>
      <div class="chart-track">
        <span style="width:${width}%; background:${subject.color}"></span>
      </div>
      <strong>${subject.minutes}m</strong>
    `;
    els.subjectStaminaChart.append(row);
  });
}

function renderSubjectSkillChart(subjects) {
  els.subjectSkillChart.innerHTML = "";
  if (!subjects.length) {
    els.subjectSkillChart.innerHTML = '<p class="empty">Add a subject to grow skill.</p>';
    return;
  }
  subjects.forEach((subject) => {
    const row = document.createElement("article");
    row.className = `chart-row skill-row${subject.averagePerformance === null ? " empty-score" : ""}`;
    const score = subject.averagePerformance === null ? 0 : subject.averagePerformance;
    row.innerHTML = `
      <span>${escapeHtml(subject.name)}</span>
      <div class="chart-track skill-track">
        <span style="width:${Math.max(6, score)}%; background:${subject.color}"></span>
      </div>
      <strong>${subject.averagePerformance === null ? "--" : `${subject.averagePerformance}%`}</strong>
    `;
    els.subjectSkillChart.append(row);
  });
}

function renderRewards(rewards) {
  els.rewardList.innerHTML = "";
  rewards.forEach((reward) => {
    const item = document.createElement("article");
    item.className = `reward ${reward.unlocked ? "unlocked" : "locked"}`;
    item.innerHTML = `<strong>${escapeHtml(reward.title)}</strong><small>${escapeHtml(reward.desc)}</small>`;
    els.rewardList.append(item);
  });
}

function renderHistory(sessions) {
  els.historyList.innerHTML = "";
  if (!sessions.length) {
    els.historyList.innerHTML = '<p class="empty">No tutoring sessions yet.</p>';
    return;
  }
  sessions.forEach((session) => {
    const item = document.createElement("article");
    item.className = "history-item";
    const score = session.performance_percent === null ? "No score" : `${session.performance_percent}%`;
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(session.subject_name)} · ${session.minutes} min</strong>
        <small>${formatDate(session.session_date)} · ${score}${session.note ? ` · ${escapeHtml(session.note)}` : ""}</small>
      </div>
      <span>${escapeHtml(session.source)}</span>
    `;
    els.historyList.append(item);
  });
}

async function submitManualSession(event) {
  event.preventDefault();
  await api(`/api/kids/${state.selectedKidId}/sessions`, {
    method: "POST",
    body: {
      subjectId: els.manualSubject.value,
      minutes: els.manualMinutes.value,
      performancePercent: els.manualPercent.value,
      note: els.manualNote.value,
      source: "manual"
    }
  });
  els.manualPercent.value = "";
  els.manualNote.value = "";
  await loadDashboard();
  toast("Session saved.");
}

function startTimer() {
  stopTimer();
  state.timer.startedAt = Date.now();
  state.timer.elapsedSeconds = 0;
  state.timer.interval = window.setInterval(updateTimerDisplay, 1000);
  updateTimerDisplay();
}

function stopTimer() {
  if (state.timer.interval) window.clearInterval(state.timer.interval);
  if (state.timer.startedAt) state.timer.elapsedSeconds = Math.max(state.timer.elapsedSeconds, Math.round((Date.now() - state.timer.startedAt) / 1000));
  state.timer.interval = null;
  state.timer.startedAt = null;
  updateTimerDisplay();
}

async function saveTimerSession() {
  stopTimer();
  const fallbackMinutes = Number(els.timerMinutes.value) || 1;
  const elapsedMinutes = Math.max(1, Math.round(state.timer.elapsedSeconds / 60));
  await api(`/api/kids/${state.selectedKidId}/sessions`, {
    method: "POST",
    body: {
      subjectId: els.timerSubject.value,
      minutes: state.timer.elapsedSeconds ? elapsedMinutes : fallbackMinutes,
      source: "timer"
    }
  });
  state.timer.elapsedSeconds = 0;
  updateTimerDisplay();
  await loadDashboard();
  toast("Timer session saved.");
}

function updateTimerDisplay() {
  const seconds = state.timer.startedAt ? Math.round((Date.now() - state.timer.startedAt) / 1000) : state.timer.elapsedSeconds;
  const minutes = Math.floor(seconds / 60);
  els.timerDisplay.textContent = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function submitGoals(event) {
  event.preventDefault();
  await api(`/api/kids/${state.selectedKidId}/goals`, {
    method: "PUT",
    body: {
      weeklyMinutes: els.goalWeekly.value,
      weekdayMinutes: els.goalWeekday.value,
      weekendMinutes: els.goalWeekend.value
    }
  });
  await loadDashboard();
  toast("Goals saved.");
}

async function submitSubject(event) {
  event.preventDefault();
  await api(`/api/kids/${state.selectedKidId}/subjects`, {
    method: "POST",
    body: { name: els.subjectName.value, color: els.subjectColor.value }
  });
  els.subjectName.value = "";
  await loadDashboard();
  toast("Subject added.");
}

async function submitParentInvite(event) {
  event.preventDefault();
  await api(`/api/families/${state.selectedFamilyId}/parent-invites`, {
    method: "POST",
    body: { email: els.parentEmail.value }
  });
  els.parentEmail.value = "";
  toast("Parent email allowed.");
}

async function submitPrize(event) {
  event.preventDefault();
  await api(`/api/kids/${state.selectedKidId}/prize`, {
    method: "PUT",
    body: { name: els.editPrizeName.value, targetDate: els.editTargetDate.value, successPercent: 100 }
  });
  await loadDashboard();
  toast("Prize saved.");
}

async function importOldSessions() {
  const raw = localStorage.getItem(oldStorageKey);
  if (!raw) return;
  const sessions = JSON.parse(raw);
  await api(`/api/kids/${state.selectedKidId}/import-local-sessions`, {
    method: "POST",
    body: { sourceKey: oldStorageKey, sessions }
  });
  els.importPanel.hidden = true;
  await loadDashboard();
  toast("Old math progress imported.");
}

async function logout() {
  await api("/auth/logout", { method: "POST", body: {} });
  window.location.href = MOUNT_PATH + "/";
}

async function api(url, options = {}) {
  const response = await fetch(MOUNT_PATH + url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

function showOnly(active) {
  [els.loginView, els.onboardingView, els.pendingApprovalView, els.appView].forEach((view) => {
    view.hidden = view !== active;
  });
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.setTimeout(() => {
    els.toast.hidden = true;
  }, 2400);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
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
