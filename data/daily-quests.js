// ════════════════════════════════════════════════════════════════════
// ASHBOUND — Daily Quests + Login Streak / Weekly Chain
// Self-contained module. Loaded as a plain <script> BEFORE index.html's
// inline script, so the global `DailyQuests` is available at runtime.
//
// Integration surface (called from index.html):
//   DailyQuests.onProfileLoaded(PLAYER, dbRow)   — after PLAYER is built
//   DailyQuests.onBattleEnd(playerWon, G)        — in renderMatchResult()
//   DailyQuests.onStatusApplied(count)           — in applyCardStatuses()
//   DailyQuests.onDamageDealt(amount)            — in resolveCard()
//   DailyQuests.onCardPlayed()                   — in resolveCard()
//   DailyQuests.openPanel()                       — from the home "DAILY" tile
//
// It talks to the game through window.__ashboundBridge (set in index.html),
// because top-level let/const there don't attach to window.
//
// Persistence: server-authoritative via new players columns
//   (daily_quests jsonb, login_streak int, last_login_date date)
// with localStorage cache + graceful degradation if the columns don't
// exist yet (so the game never breaks before the SQL migration is run).
// ════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  function B() { return window.__ashboundBridge || {}; }
  function toast(msg) { const f = B().toast; if (f) try { f(msg); } catch (e) {} }
  async function persistGold(n) { const f = B().persistGold; if (f) { try { return await f(n); } catch (e) {} } }
  async function persistXP(n)   { const f = B().persistXP;   if (f) { try { return await f(n); } catch (e) {} } }

  // ── helpers ───────────────────────────────────────────────────────
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function daysBetween(a, b) {
    const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
    const db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
    return Math.round((db - da) / 86400000);
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }

  // ── quest catalogue ───────────────────────────────────────────────
  const ELEMENTS = ['flame', 'water', 'earth', 'storm', 'void', 'nature'];
  const ELEMENT_NAME = { flame: 'Flame', water: 'Water', earth: 'Earth', storm: 'Storm', void: 'Void', nature: 'Nature' };

  const QUEST_DEFS = [
    { id: 'win_solo',     track: 'win_solo',   min: 2, max: 3,  gold: 80,  xp: 50, label: (n) => `Win ${n} Solo battles` },
    { id: 'win_any',      track: 'win_any',    min: 2, max: 4,  gold: 70,  xp: 45, label: (n) => `Win ${n} battles (any mode)` },
    { id: 'play_battles', track: 'play_any',   min: 3, max: 5,  gold: 50,  xp: 35, label: (n) => `Play ${n} battles` },
    { id: 'apply_status', track: 'status',     min: 5, max: 10, gold: 90,  xp: 55, label: (n) => `Apply ${n} status effects` },
    { id: 'deal_damage',  track: 'damage',     min: 800, max: 1500, gold: 80, xp: 50, label: (n) => `Deal ${n} total damage` },
    { id: 'play_cards',   track: 'cards',      min: 15, max: 25, gold: 60,  xp: 40, label: (n) => `Play ${n} cards` },
    { id: 'win_element',  track: 'win_element', min: 1, max: 2,  gold: 100, xp: 60, element: true, label: (n, el) => `Win ${n} battle${n > 1 ? 's' : ''} as a ${ELEMENT_NAME[el]} team` },
    { id: 'win_mp',       track: 'win_mp',     min: 1, max: 2,  gold: 120, xp: 70, label: (n) => `Win ${n} Multiplayer match${n > 1 ? 'es' : ''}` },
  ];

  // ── 7-day login chain (cycles; day 7 = guaranteed emblem case) ─────
  const CHAIN = [
    { day: 1, gold: 50,  xp: 20,  label: '50 Gold' },
    { day: 2, gold: 80,  xp: 30,  label: '80 Gold' },
    { day: 3, gold: 0,   xp: 60,  label: '60 XP' },
    { day: 4, gold: 120, xp: 40,  label: '120 Gold' },
    { day: 5, gold: 0,   xp: 100, label: '100 XP' },
    { day: 6, gold: 180, xp: 60,  label: '180 Gold' },
    { day: 7, gold: 100, xp: 80,  caseId: 'AUTO', label: 'Emblem Case +100g' },
  ];

  function pickEmblemCaseId() {
    const cases = B().getLootCases ? B().getLootCases() : [];
    if (!cases || !cases.length) return null;
    const byName = cases.find(c => /emblem|emperor|mystic/i.test((c.id || '') + ' ' + (c.name || '')));
    if (byName) return byName.id;
    const sorted = cases.slice().sort((a, b) => (a.cost || 0) - (b.cost || 0));
    return sorted[Math.min(1, sorted.length - 1)].id;
  }

  // ── module state ──────────────────────────────────────────────────
  const S = {
    ready: false, playerId: null, playerRef: null,
    date: null, quests: [],
    loginStreak: 0, lastLoginDate: null, chainClaimedToday: false,
    _saveTimer: null,
  };

  function lsKey(pid) { return 'ashbound_daily_' + (pid || 'anon'); }
  function loadCache(pid) { return safe(() => { const raw = localStorage.getItem(lsKey(pid)); return raw ? JSON.parse(raw) : null; }); }
  function saveCache() {
    safe(() => localStorage.setItem(lsKey(S.playerId), JSON.stringify({
      date: S.date, quests: S.quests, loginStreak: S.loginStreak,
      lastLoginDate: S.lastLoginDate, chainClaimedToday: S.chainClaimedToday,
    })));
  }

  async function persistServer() {
    const db = B().getDb ? B().getDb() : null;
    const pid = S.playerRef && S.playerRef.id;
    if (!db || !pid) return;
    try {
      const payload = {
        daily_quests: { date: S.date, quests: S.quests, chainClaimedToday: S.chainClaimedToday },
        login_streak: S.loginStreak,
        last_login_date: S.lastLoginDate,
      };
      const { error } = await db.from('players').update(payload).eq('id', pid);
      if (error && /column .* does not exist|schema cache|could not find/i.test(error.message || '')) {
        if (!persistServer._warned) { console.warn('[DailyQuests] DB columns missing; using localStorage until migration is run.'); persistServer._warned = true; }
      }
    } catch (e) { /* network/RLS — cache already saved */ }
  }

  function markDirty() {
    saveCache();
    clearTimeout(S._saveTimer);
    S._saveTimer = setTimeout(persistServer, 600);
  }

  // ── quest generation ──────────────────────────────────────────────
  function rollGoal(def) {
    if (def.max <= def.min) return def.min;
    let n = def.min + Math.floor(Math.random() * (def.max - def.min + 1));
    if (def.track === 'damage') n = Math.round(n / 100) * 100;
    return n;
  }
  function generateQuests() {
    const pool = QUEST_DEFS.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, 3).map((def, idx) => {
      const goal = rollGoal(def);
      const element = def.element ? ELEMENTS[Math.floor(Math.random() * ELEMENTS.length)] : null;
      return {
        uid: def.id + '_' + idx, defId: def.id, track: def.track, element, goal,
        progress: 0, claimed: false, gold: def.gold, xp: def.xp,
        label: def.element ? def.label(goal, element) : def.label(goal),
      };
    });
  }

  // ── login streak / chain ──────────────────────────────────────────
  function processLogin() {
    const today = todayStr();
    if (S.lastLoginDate === today) return;          // already counted today
    const gap = S.lastLoginDate ? daysBetween(S.lastLoginDate, today) : null;
    S.loginStreak = (gap === 1) ? (S.loginStreak || 0) + 1 : 1;
    S.lastLoginDate = today;
    S.chainClaimedToday = false;
    markDirty();
  }
  function chainTierForStreak(streak) { return CHAIN[(Math.max(1, streak) - 1) % 7]; }

  async function claimChain() {
    if (S.chainClaimedToday) { toast("Today's login reward is already claimed."); return; }
    const tier = chainTierForStreak(S.loginStreak);
    S.chainClaimedToday = true;
    markDirty();
    const parts = [];
    if (tier.gold) { await persistGold(tier.gold); parts.push(tier.gold + ' gold'); }
    if (tier.xp)   { await persistXP(tier.xp);     parts.push(tier.xp + ' XP'); }
    if (tier.caseId) {
      const caseId = (tier.caseId === 'AUTO') ? pickEmblemCaseId() : tier.caseId;
      const cases = B().getLootCases ? B().getLootCases() : [];
      const c = cases.find(x => x.id === caseId);
      const roll = B().rollCaseContents, award = B().awardDrop, openFx = B().showCaseOpening;
      if (c && roll && award) {
        const drops = roll(c.id);
        for (const d of drops) { try { await award(d); } catch (e) {} }
        parts.push('an Emblem Case');
        if (openFx) { try { await openFx(c, drops); } catch (e) {} }
      } else {
        await persistGold(150); parts.push('150 gold (case unavailable)');
      }
    }
    toast('🎁 Day ' + tier.day + ' reward: ' + parts.join(' + '));
    render();
  }

  // ── progress tracking ─────────────────────────────────────────────
  function bump(track, amount, meta) {
    if (!S.ready) return;
    let changed = false;
    for (const q of S.quests) {
      if (q.claimed || q.progress >= q.goal || q.track !== track) continue;
      if (q.track === 'win_element' && meta && meta.element && q.element !== meta.element) continue;
      q.progress = clamp(q.progress + amount, 0, q.goal);
      changed = true;
    }
    if (changed) { markDirty(); render(); }
  }

  function majorityElement(team) {
    if (!Array.isArray(team) || !team.length) return null;
    const counts = {};
    for (const c of team) { if (c && c.cls) counts[c.cls] = (counts[c.cls] || 0) + 1; }
    let best = null, bestN = 0;
    for (const k in counts) if (counts[k] > bestN) { best = k; bestN = counts[k]; }
    return bestN >= 3 ? best : null;
  }

  // ── per-quest claim ───────────────────────────────────────────────
  async function claimQuest(uid) {
    const q = S.quests.find(x => x.uid === uid);
    if (!q || q.claimed || q.progress < q.goal) return;
    q.claimed = true;
    markDirty();
    const parts = [];
    if (q.gold) { await persistGold(q.gold); parts.push(q.gold + ' gold'); }
    if (q.xp)   { await persistXP(q.xp);     parts.push(q.xp + ' XP'); }
    toast('✅ Quest complete: +' + parts.join(' + '));
    render();
  }

  // ── public API ────────────────────────────────────────────────────
  const DailyQuests = {
    onProfileLoaded(PLAYER, dbRow) {
      S.playerRef = PLAYER || null;
      S.playerId = (PLAYER && PLAYER.id) || 'anon';
      const today = todayStr();

      let src = null;
      if (dbRow && (dbRow.daily_quests || dbRow.login_streak != null || dbRow.last_login_date)) {
        src = {
          date: dbRow.daily_quests && dbRow.daily_quests.date,
          quests: (dbRow.daily_quests && dbRow.daily_quests.quests) || null,
          loginStreak: dbRow.login_streak || 0,
          lastLoginDate: dbRow.last_login_date || null,
          chainClaimedToday: dbRow.daily_quests && dbRow.daily_quests.chainClaimedToday,
        };
      } else {
        src = loadCache(S.playerId);
      }
      if (src) {
        S.loginStreak = src.loginStreak || 0;
        S.lastLoginDate = src.lastLoginDate || null;
        S.date = src.date || null;
        S.quests = Array.isArray(src.quests) ? src.quests : [];
        S.chainClaimedToday = !!src.chainClaimedToday;
      }
      if (S.date !== today || !S.quests.length) {
        S.date = today;
        S.quests = generateQuests();
        S.chainClaimedToday = false;
      }
      S.ready = true;
      processLogin();
      saveCache();
      persistServer();
      updateBadge();
      render();
    },

    onBattleEnd(playerWon, G) {
      if (!S.ready) return;
      const isMP = G && G.mode === 'mp';
      bump('play_any', 1);
      if (playerWon) {
        bump('win_any', 1);
        if (isMP) bump('win_mp', 1); else bump('win_solo', 1);
        const el = majorityElement(G && G.playerTeam);
        if (el) bump('win_element', 1, { element: el });
      }
    },
    onStatusApplied(count) { bump('status', count || 1); },
    onDamageDealt(amount) { bump('damage', amount || 0); },
    onCardPlayed() { bump('cards', 1); },

    openPanel() { ensureUI(); render(); document.getElementById('dq-overlay').classList.add('dq-open'); },
    closePanel() { const o = document.getElementById('dq-overlay'); if (o) o.classList.remove('dq-open'); },
    _state: S,
  };

  // ── UI (self-injected modal + CSS + home badge) ───────────────────
  function ensureUI() {
    if (document.getElementById('dq-overlay')) return;
    const style = document.createElement('style');
    style.id = 'dq-style';
    style.textContent = `
      #dq-overlay { position:fixed; inset:0; z-index:9000; display:none; align-items:center; justify-content:center;
        background:rgba(6,4,14,0.72); backdrop-filter:blur(6px); }
      #dq-overlay.dq-open { display:flex; animation:dqFade .2s ease; }
      @keyframes dqFade { from{opacity:0} to{opacity:1} }
      .dq-modal { width:min(560px,94vw); max-height:88vh; overflow-y:auto; background:linear-gradient(160deg,#150f28,#0d0a1c);
        border:1px solid rgba(232,197,106,0.28); border-radius:18px; padding:22px 22px 26px; box-shadow:0 24px 80px rgba(0,0,0,.6); }
      .dq-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
      .dq-title { font-family:'Cinzel Decorative',serif; font-size:22px; color:#e8c56a; letter-spacing:2px; }
      .dq-x { background:none; border:none; color:#9a92b5; font-size:22px; cursor:pointer; line-height:1; }
      .dq-x:hover { color:#fff; }
      .dq-sub { color:#9a92b5; font-size:12px; letter-spacing:1px; margin-bottom:16px; }
      .dq-section { font-family:'Rajdhani',sans-serif; font-weight:700; letter-spacing:2px; color:#7fb0ff; font-size:13px; margin:14px 0 8px; }
      .dq-quest { display:flex; align-items:center; gap:12px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06);
        border-radius:12px; padding:12px 14px; margin-bottom:10px; }
      .dq-quest.done { border-color:rgba(125,255,176,0.4); background:rgba(125,255,176,0.06); }
      .dq-quest.claimed { opacity:.55; }
      .dq-q-main { flex:1; min-width:0; }
      .dq-q-label { color:#e8e2f4; font-size:13px; margin-bottom:6px; }
      .dq-bar { height:7px; border-radius:50px; background:rgba(255,255,255,0.08); overflow:hidden; }
      .dq-bar-fill { height:100%; background:linear-gradient(90deg,#7b3fe0,#e8c56a); transition:width .4s ease; }
      .dq-q-meta { font-size:11px; color:#9a92b5; margin-top:5px; display:flex; justify-content:space-between; }
      .dq-q-reward { color:#e8c56a; }
      .dq-claim { flex-shrink:0; background:linear-gradient(135deg,#e8c56a,#caa23f); color:#1a1206; border:none; border-radius:8px;
        padding:8px 12px; font-family:'Rajdhani',sans-serif; font-weight:700; letter-spacing:1px; cursor:pointer; font-size:12px; }
      .dq-claim:disabled { background:rgba(255,255,255,0.08); color:#6b6685; cursor:default; }
      .dq-chain { display:grid; grid-template-columns:repeat(7,1fr); gap:6px; margin-top:6px; }
      .dq-day { text-align:center; border-radius:10px; border:1px solid rgba(255,255,255,0.08); padding:8px 2px 7px;
        background:rgba(255,255,255,0.03); position:relative; }
      .dq-day .dq-d-num { font-size:9px; color:#9a92b5; letter-spacing:1px; }
      .dq-day .dq-d-emoji { font-size:18px; margin:3px 0; }
      .dq-day .dq-d-rw { font-size:8.5px; color:#cfc8e6; line-height:1.15; }
      .dq-day.past { opacity:.5; }
      .dq-day.today { border-color:#e8c56a; box-shadow:0 0 12px rgba(232,197,106,0.35); background:rgba(232,197,106,0.08); }
      .dq-day.day7 .dq-d-emoji { filter:drop-shadow(0 0 4px #e8c56a); }
      .dq-streak-line { font-size:12px; color:#cfc8e6; margin:10px 0 4px; }
      .dq-streak-line b { color:#e8c56a; }
      .dq-chain-claim { width:100%; margin-top:12px; background:linear-gradient(135deg,#7b3fe0,#4a20a0); color:#fff; border:none;
        border-radius:10px; padding:12px; font-family:'Rajdhani',sans-serif; font-weight:700; letter-spacing:2px; cursor:pointer; }
      .dq-chain-claim:disabled { background:rgba(255,255,255,0.08); color:#6b6685; cursor:default; }
      .dq-badge { position:absolute; top:8px; right:8px; min-width:18px; height:18px; padding:0 5px; border-radius:50px;
        background:#e8554f; color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center;
        box-shadow:0 0 8px rgba(232,85,79,.6); }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'dq-overlay';
    overlay.innerHTML = `<div class="dq-modal" role="dialog" aria-label="Daily Rewards">
      <div class="dq-head"><div class="dq-title">Daily Rewards</div><button class="dq-x" id="dq-close">✕</button></div>
      <div class="dq-sub">Resets at local midnight · come back daily to grow your streak</div>
      <div id="dq-quests-wrap"></div>
      <div class="dq-section">7-DAY LOGIN CHAIN</div>
      <div id="dq-chain-wrap"></div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) DailyQuests.closePanel(); });
    document.getElementById('dq-close').addEventListener('click', () => DailyQuests.closePanel());
  }

  function render() {
    if (!document.getElementById('dq-overlay')) return;
    const qWrap = document.getElementById('dq-quests-wrap');
    if (qWrap) {
      qWrap.innerHTML = '<div class="dq-section">TODAY\'S QUESTS</div>' + S.quests.map(q => {
        const done = q.progress >= q.goal;
        const pct = Math.round(clamp(q.progress / q.goal, 0, 1) * 100);
        return `<div class="dq-quest ${done ? 'done' : ''} ${q.claimed ? 'claimed' : ''}">
          <div class="dq-q-main">
            <div class="dq-q-label">${q.label}</div>
            <div class="dq-bar"><div class="dq-bar-fill" style="width:${pct}%"></div></div>
            <div class="dq-q-meta"><span>${Math.min(q.progress, q.goal)} / ${q.goal}</span>
              <span class="dq-q-reward">+${q.gold ? q.gold + '🪙 ' : ''}${q.xp ? q.xp + 'XP' : ''}</span></div>
          </div>
          <button class="dq-claim" data-uid="${q.uid}" ${(!done || q.claimed) ? 'disabled' : ''}>${q.claimed ? '✓' : 'CLAIM'}</button>
        </div>`;
      }).join('');
      qWrap.querySelectorAll('.dq-claim').forEach(b => b.addEventListener('click', () => claimQuest(b.dataset.uid)));
    }
    const cWrap = document.getElementById('dq-chain-wrap');
    if (cWrap) {
      const curTier = chainTierForStreak(S.loginStreak);
      const cells = CHAIN.map(t => {
        const cls = t.day < curTier.day ? 'past' : (t.day === curTier.day ? 'today' : '');
        const emoji = t.caseId ? '🎁' : (t.gold && !t.xp ? '🪙' : (t.xp && !t.gold ? '✨' : '🎖'));
        return `<div class="dq-day ${cls} ${t.day === 7 ? 'day7' : ''}">
          <div class="dq-d-num">DAY ${t.day}</div><div class="dq-d-emoji">${emoji}</div>
          <div class="dq-d-rw">${t.label}</div></div>`;
      }).join('');
      const claimable = !S.chainClaimedToday;
      cWrap.innerHTML = `<div class="dq-chain">${cells}</div>
        <div class="dq-streak-line">Current streak: <b>${S.loginStreak} day${S.loginStreak === 1 ? '' : 's'}</b> · Today: <b>Day ${curTier.day}</b> (${curTier.label})</div>
        <button class="dq-chain-claim" id="dq-claim-chain" ${claimable ? '' : 'disabled'}>${claimable ? 'CLAIM DAY ' + curTier.day + ' REWARD' : '✓ CLAIMED TODAY — COME BACK TOMORROW'}</button>`;
      const cc = document.getElementById('dq-claim-chain');
      if (cc) cc.addEventListener('click', claimChain);
    }
    updateBadge();
  }

  function claimableCount() {
    let n = S.quests.filter(q => !q.claimed && q.progress >= q.goal).length;
    if (S.ready && !S.chainClaimedToday) n += 1;
    return n;
  }
  function updateBadge() {
    const card = document.getElementById('home-daily');
    if (!card) return;
    let badge = card.querySelector('.dq-badge');
    const n = claimableCount();
    if (n > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'dq-badge'; card.appendChild(badge); }
      badge.textContent = n;
    } else if (badge) { badge.remove(); }
  }

  setInterval(() => { if (S.ready) updateBadge(); }, 2500);

  window.DailyQuests = DailyQuests;
})();
