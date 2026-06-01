// ════════════════════════════════════════════════════════════════════
// ASHBOUND — PATH EXPEDITION (co-op PvE roguelite)
// Self-contained module loaded as a <script> before index.html's inline
// script. Drives the engine through window.__pathBridge (set in index.html).
//
//   • A run = a 25-node branching map. Boss node every 5 levels (5,10,15,20,25).
//   • Node types: battle, elite, rest, reward, boss.
//   • Reuses the entire battle engine (frontline/backline, targeting, statuses,
//     emblems, team synergies) via __pathBridge.startPathBattle().
//   • Persistence: localStorage now (per user-id), with an optional Supabase
//     table later. The once-per-account final Spirit reward unlocks via the
//     existing server-side player_spirits table (unlockSpiritById).
//   • Failed runs still grant Shards (meta currency) scaled by depth reached.
//   • Co-op (2-player) is architected-for: the map/seed is shareable and the
//     bridge is host-authoritative-ready, but v1 ships solo-complete. See
//     PathCoop stub at the bottom.
// ════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  function P() { return window.__pathBridge || {}; }
  function toast(m) { const f = P().toast; if (f) try { f(m); } catch (e) {} }
  function spirits() { return P().getSpirits ? P().getSpirits() : []; }
  function player() { return P().getPlayer ? P().getPlayer() : null; }

  // ── seeded RNG (so a run's map is reproducible + co-op shareable) ──
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function shuffle(rng, arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // ── BOSS DEFINITIONS (one per boss node, 5 total) ──────────────────
  // Each boss is a synthetic combatant + a data-driven `mechanics` def the
  // engine's bossOnEnemyTurn() reads (phases / enrage / shieldEvery / addsEvery).
  // Themed to Ashbound's six classes.
  function bossCard(name, emoji, cost, type, power, targeting, desc, apply, extra) {
    const c = { name, emoji, cost, type, power, desc, targeting, effect: null, apply: apply || null };
    if (extra) Object.assign(c, extra);
    return c;
  }
  const A = (k, n, to) => ({ k, n, to: to || 'target' });

  const BOSSES = {
    pyrelord: {
      id: 'boss_pyrelord', name: 'Ignarok, the Pyre Lord', subtitle: 'Flame · burns the unworthy',
      emoji: '🔥', cls: 'flame', hp: 1500, atk: 105, _isBoss: true,
      parts: [
        bossCard('Cinder Crash', '🔥', 2, 'damage', 130, 'select_front', 'A molten fist.'),
        bossCard('Eruption', '💥', 3, 'aoe', 85, 'all', 'Scorches all foes.', [A('bleed', 1, 'allEnemies')]),
        bossCard('Searing Mark', '☄', 2, 'damage', 70, 'random_any', 'Brands a foe.', [A('vulnerable', 2, 'target')]),
      ],
      mechanics: {
        phases: [{ belowPct: 0.5, announce: 'flames roar higher', onEnter: (b) => { b.atkMod *= 1.25; } }],
        enrageTurn: 8, enrageMult: 1.6,
        add: { name: 'Ember Wisp', emoji: '🔥', cls: 'flame', hp: 220, atk: 70,
               parts: [bossCard('Spark', '✨', 1, 'damage', 60, 'random_front', 'A darting spark.')] },
        addsEvery: 3, maxAdds: 2,
      },
    },
    tideturl: {
      id: 'boss_tidetyrant', name: 'Voraxis, the Tide Tyrant', subtitle: 'Water · drowns all hope',
      emoji: '🌊', cls: 'water', hp: 1700, atk: 92, _isBoss: true,
      parts: [
        bossCard('Crushing Wave', '🌊', 2, 'damage', 120, 'select_front', 'A wall of water.', [A('weak', 2, 'target')]),
        bossCard('Maelstrom', '🌀', 3, 'aoe', 80, 'all', 'A spinning vortex.'),
        bossCard('Tidal Mend', '💧', 2, 'heal', 160, 'self', 'The tyrant knits its wounds.'),
      ],
      mechanics: {
        shieldEvery: 2, shieldAmount: 140,
        phases: [{ belowPct: 0.4, announce: 'the depths churn', onEnter: (b, G) => { for (const c of G.enemyTeam) c.healMod *= 1.5; } }],
        enrageTurn: 10, enrageMult: 1.5,
      },
    },
    stonecolossus: {
      id: 'boss_stonecolossus', name: 'Gravemaw, the Stone Colossus', subtitle: 'Earth · immovable, unending',
      emoji: '🗿', cls: 'earth', hp: 2200, atk: 85, _isBoss: true,
      parts: [
        bossCard('Boulder Throw', '🪨', 2, 'damage', 125, 'select_front', 'Hurls a boulder.'),
        bossCard('Quake', '💢', 3, 'aoe', 75, 'all', 'The ground splits.', [A('weak', 1, 'allEnemies')]),
        bossCard('Stone Skin', '🛡', 1, 'shield', 130, 'self', 'Hardens to granite.'),
      ],
      mechanics: {
        shieldEvery: 2, shieldAmount: 160,
        enrageTurn: 12, enrageMult: 1.7,
        phases: [{ belowPct: 0.3, announce: 'cracks blaze with fury', onEnter: (b) => { b.atkMod *= 1.4; } }],
      },
    },
    voidmaw: {
      id: 'boss_voidmaw', name: 'Nul\'Khareth, the Void Maw', subtitle: 'Void · devours light',
      emoji: '🕳', cls: 'void', hp: 1800, atk: 100, _isBoss: true,
      parts: [
        bossCard('Soul Rend', '🌑', 2, 'damage', 110, 'pierce', 'Strikes any foe.', [A('heal_block', 2, 'target')], { pierce: true }),
        bossCard('Entropy', '🌀', 3, 'aoe', 70, 'all', 'Unmakes all.', [A('vulnerable', 1, 'allEnemies')]),
        bossCard('Devour', '🦷', 2, 'damage', 90, 'random_any', 'Feeds on a foe.', null, { lifesteal: 0.6 }),
      ],
      mechanics: {
        phases: [
          { belowPct: 0.6, announce: 'shadows multiply', onEnter: () => {} },
          { belowPct: 0.3, announce: 'the maw widens', onEnter: (b) => { b.atkMod *= 1.3; } },
        ],
        enrageTurn: 9, enrageMult: 1.6,
        add: { name: 'Void Spawn', emoji: '👾', cls: 'void', hp: 260, atk: 80,
               parts: [bossCard('Gnaw', '🦷', 1, 'damage', 65, 'random_front', 'A hungry bite.', [A('weak', 1, 'target')])] },
        addsEvery: 2, maxAdds: 3,
      },
    },
    stormcrown: {
      id: 'boss_stormcrown', name: 'Aetheron, the Storm Crown', subtitle: 'Storm · the final tempest',
      emoji: '⚡', cls: 'storm', hp: 2600, atk: 110, _isBoss: true,
      parts: [
        bossCard('Thunderstrike', '⚡', 2, 'damage', 135, 'select_front', 'A bolt from the crown.'),
        bossCard('Tempest', '🌪', 3, 'aoe', 95, 'all', 'The sky falls.', [A('silence', 1, 'allEnemies')]),
        bossCard('Static Field', '🔱', 2, 'damage', 80, 'random_any', 'Chained lightning.', [A('vulnerable', 2, 'target')]),
        bossCard('Storm Ward', '🛡', 1, 'shield', 150, 'self', 'Wraps in living storm.'),
      ],
      mechanics: {
        shieldEvery: 3, shieldAmount: 150,
        phases: [
          { belowPct: 0.66, announce: 'the winds scream', onEnter: (b) => { b.atkMod *= 1.2; } },
          { belowPct: 0.33, announce: 'the crown blazes white', onEnter: (b) => { b.atkMod *= 1.3; } },
        ],
        enrageTurn: 10, enrageMult: 1.8,
        add: { name: 'Storm Herald', emoji: '⚡', cls: 'storm', hp: 300, atk: 90,
               parts: [bossCard('Shock', '⚡', 1, 'damage', 70, 'random_front', 'A crackling jolt.')] },
        addsEvery: 4, maxAdds: 2,
      },
    },
  };
  // Boss order by depth (node index 5,10,15,20,25 → these bosses).
  const BOSS_ORDER = ['pyrelord', 'tideturl', 'stonecolossus', 'voidmaw', 'stormcrown'];

  const MODIFIER_POOL = ['enemy_atk_up', 'enemy_hp_up', 'player_no_heal', 'less_energy', 'thorns'];
  const MOD_LABEL = { enemy_atk_up: 'Enemies +20% damage', enemy_hp_up: 'Enemies +25% HP',
    player_no_heal: 'Healing disabled', less_energy: '-1 max energy', thorns: 'Enemy thorns 10%' };

  // ── MAP GENERATION ─────────────────────────────────────────────────
  // 25 nodes in 5 tiers of 5. Each non-boss tier offers a branching choice
  // (the player picks 1 of up to 2 reachable nodes); every 5th node is a boss
  // that all branches converge on.
  const NODE_TYPES_NORMAL = ['battle', 'battle', 'elite', 'rest', 'reward'];
  function generateMap(seed) {
    const rng = makeRng(seed);
    const nodes = [];
    for (let i = 0; i < 25; i++) {
      const depth = i + 1;
      const isBoss = depth % 5 === 0;
      let type;
      if (isBoss) type = 'boss';
      else {
        // weight: more battles early, reward/rest sprinkled, elites mid/late
        const roll = rng();
        if (roll < 0.46) type = 'battle';
        else if (roll < 0.66) type = (depth >= 6 ? 'elite' : 'battle');
        else if (roll < 0.82) type = 'rest';
        else type = 'reward';
      }
      const tier = Math.floor(i / 5);            // 0..4
      const node = {
        idx: i, depth, type, tier,
        cleared: false,
        // branch column 0..1 for non-boss nodes (boss is centered)
        col: isBoss ? 1 : (i % 2),
        modifiers: [],
        enemyCount: isBoss ? 1 : (type === 'elite' ? 5 : (3 + Math.floor(rng() * 3))),
        title: '',
        bossKey: isBoss ? BOSS_ORDER[tier] : null,
      };
      // Raid modifiers: elites get 1, bosses get 1, deeper tiers add more.
      if (type === 'elite' || type === 'boss') {
        const m = pick(rng, MODIFIER_POOL);
        node.modifiers.push(m);
        if (type === 'boss' && tier >= 3) { const m2 = pick(rng, MODIFIER_POOL.filter(x => x !== m)); node.modifiers.push(m2); }
      }
      node.title = nodeTitle(node, rng);
      node.enemySeed = (seed ^ (depth * 2654435761)) >>> 0;
      nodes.push(node);
    }
    return nodes;
  }
  function nodeTitle(node, rng) {
    if (node.type === 'boss') return BOSSES[node.bossKey].name;
    const battleNames = ['Ashen Hollow', 'Veil Crossing', 'Broken Span', 'Mist Gully', 'Ember Steps', 'Hollow Reach', 'Cinder Vale', 'Pale Gate'];
    const eliteNames = ['Warded Shrine', 'Champion\'s Rest', 'Elite Vanguard', 'Cursed Altar'];
    if (node.type === 'rest') return 'Wayshrine (Rest)';
    if (node.type === 'reward') return 'Spirit Cache (Reward)';
    if (node.type === 'elite') return pick(rng, eliteNames);
    return pick(rng, battleNames);
  }

  // Build the enemy team spec for a node (real spirits for normal/elite,
  // synthetic boss [+adds spawn dynamically] for boss nodes).
  function buildEnemySpecs(node) {
    if (node.type === 'boss') {
      const b = BOSSES[node.bossKey];
      // boss starts alone; adds spawn via mechanics. Optionally 1 guard add.
      const specs = [Object.assign({ synthetic: true }, b)];
      return specs;
    }
    const rng = makeRng(node.enemySeed);
    const all = spirits();
    const myTeam = new Set((RUN && RUN.team) || []);
    const pool = all.filter(s => !myTeam.has(s.id));
    const chosen = shuffle(rng, pool).slice(0, node.enemyCount);
    // Elites get a stat bump baked in (separate from raid modifiers).
    return chosen.map(s => {
      if (node.type === 'elite') {
        return { synthetic: true, id: s.id, name: s.name, emoji: s.emoji, img: s.img, cls: s.cls,
          hp: Math.round(s.hp * 1.3), atk: Math.round(s.atk * 1.1), spd: s.spd, passive: s.passive, parts: s.parts };
      }
      return s.id; // normal nodes use the real spirit
    });
  }

  // ── RUN STATE + persistence ────────────────────────────────────────
  let RUN = null;   // { seed, nodes, pos, team, gold, shards, fragments, alive, modifiersSeen, finished }
  function lsKey() { const p = player(); return 'ashbound_path_' + ((p && p.id) || 'anon'); }
  function metaKey() { const p = player(); return 'ashbound_pathmeta_' + ((p && p.id) || 'anon'); }
  function loadRun() { try { const r = localStorage.getItem(lsKey()); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function saveRun() { try { localStorage.setItem(lsKey(), JSON.stringify(RUN)); } catch (e) {} }
  function clearRun() { try { localStorage.removeItem(lsKey()); } catch (e) {} RUN = null; }
  // Meta = account-level progress that survives runs (shards bank, final spirit claimed).
  function loadMeta() { try { const r = localStorage.getItem(metaKey()); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function saveMeta(m) { try { localStorage.setItem(metaKey(), JSON.stringify(m)); } catch (e) {} }
  function meta() { if (!loadMeta()) saveMeta({ shards: 0, fragments: 0, finalSpiritClaimed: false, runsCompleted: 0, deepestDepth: 0 }); return loadMeta(); }
  function setMeta(patch) { const m = meta(); Object.assign(m, patch); saveMeta(m); }

  // ── REWARD SPIRIT POOL for the final once-per-account choice ────────
  // Offer 3 spirits the player does NOT yet own; if they own (almost) all,
  // fall back to a gold/shard windfall.
  function rollFinalSpiritChoices() {
    const all = spirits();
    const locked = all.filter(s => !(P().isUnlocked && P().isUnlocked(s.id)));
    const rng = makeRng((RUN && RUN.seed) ^ 0xABCDEF);
    return shuffle(rng, locked).slice(0, 3).map(s => s.id);
  }

  // ════════════════════════════════════════════════════════════════════
  // PUBLIC ENTRY
  // ════════════════════════════════════════════════════════════════════
  const PathExpedition = {
    open() {
      ensureUI();
      RUN = loadRun();
      if (RUN && !RUN.finished) renderRunMap();
      else renderRunSetup();
      showPathScreen();
    },
    close() { if (P().showHome) P().showHome(); },
    _debug: () => ({ RUN, meta: meta() }),
  };

  function showPathScreen() {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    const el = document.getElementById('s-path');
    if (el) el.classList.remove('hidden');
  }

  // ── Setup screen: choose 5 spirits, start a run ────────────────────
  let setupPicks = [];
  function renderRunSetup() {
    const wrap = document.getElementById('path-body');
    const p = player();
    const owned = spirits().filter(s => p && p.unlocked.includes(s.id));
    const m = meta();
    wrap.innerHTML = `
      <div class="path-setup">
        <div class="path-intro">
          <h3>THE LONG PATH</h3>
          <p>Brave 25 nodes of escalating danger. A great spirit-lord waits at every fifth node.
          Fall, and you still carry home <b>Shards</b> for how far you reached. Reach the end and claim
          a once-per-account <b>legendary spirit</b>.</p>
          <div class="path-meta-row">
            <span>💠 Shards banked: <b>${m.shards}</b></span>
            <span>🏆 Runs completed: <b>${m.runsCompleted}</b></span>
            <span>⛰ Deepest: <b>${m.deepestDepth}/25</b></span>
            ${m.finalSpiritClaimed ? '<span style="color:#7affb0;">✦ Final spirit claimed</span>' : ''}
          </div>
        </div>
        <div class="path-pick-title">Choose your 5 spirits — order sets Frontline (1-2) / Backline (3-5)</div>
        <div class="path-pick-slots" id="path-pick-slots"></div>
        <div class="path-pick-grid" id="path-pick-grid"></div>
        <button class="path-start-btn" id="path-start-btn" disabled>BEGIN EXPEDITION</button>
      </div>`;
    setupPicks = [];
    renderSetupSlots();
    const grid = document.getElementById('path-pick-grid');
    grid.innerHTML = owned.map(s => `
      <div class="path-pick-card" data-id="${s.id}">
        <div class="ppc-emoji">${s.emoji}</div>
        <div class="ppc-name">${s.name}</div>
        <div class="ppc-cls cls-${s.cls}">${s.cls}</div>
        <div class="ppc-stats">❤${s.hp} ⚔${s.atk}</div>
      </div>`).join('');
    grid.querySelectorAll('.path-pick-card').forEach(card => {
      card.addEventListener('click', () => toggleSetupPick(card.dataset.id));
    });
    document.getElementById('path-start-btn').addEventListener('click', startRun);
  }
  function toggleSetupPick(id) {
    const i = setupPicks.indexOf(id);
    if (i >= 0) setupPicks.splice(i, 1);
    else { if (setupPicks.length >= 5) { toast('Team is full (5)'); return; } setupPicks.push(id); }
    renderSetupSlots();
    document.querySelectorAll('.path-pick-card').forEach(c => c.classList.toggle('picked', setupPicks.includes(c.dataset.id)));
    const btn = document.getElementById('path-start-btn');
    if (btn) btn.disabled = setupPicks.length !== 5;
  }
  function renderSetupSlots() {
    const row = document.getElementById('path-pick-slots');
    if (!row) return;
    let html = '';
    for (let i = 0; i < 5; i++) {
      const id = setupPicks[i];
      const s = id && spirits().find(x => x.id === id);
      const isFront = i <= 1;
      html += `<div class="path-slot ${isFront ? 'pf' : 'pb'} ${s ? 'filled' : ''}">
        <span class="path-slot-tag">${isFront ? 'FRONT' : 'BACK'}</span>
        ${s ? `<span class="pps-emoji">${s.emoji}</span><span class="pps-name">${s.name}</span>` : `<span class="pps-plus">+</span>`}
      </div>`;
    }
    row.innerHTML = html;
  }

  function startRun() {
    if (setupPicks.length !== 5) return;
    const seed = (Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0;
    RUN = {
      seed, nodes: generateMap(seed), pos: -1, team: setupPicks.slice(),
      gold: 0, shards: 0, fragments: 0, finished: false, reachedDepth: 0,
      // teamHp carries survivor HP% between battles (anti-faceroll attrition)
      teamHp: {},
    };
    setupPicks.forEach(id => { RUN.teamHp[id] = 1; });
    saveRun();
    renderRunMap();
  }

  // ── Map screen ─────────────────────────────────────────────────────
  function availableNextNodes() {
    // The next tier's nodes reachable from current pos. Nodes advance linearly
    // by depth; at each non-boss step the player chooses between the 2 columns
    // of the NEXT depth (boss nodes are forced/centered).
    if (!RUN) return [];
    const nextDepth = RUN.pos < 0 ? 1 : RUN.nodes[RUN.pos].depth + 1;
    if (nextDepth > 25) return [];
    const candidates = RUN.nodes.filter(n => n.depth === nextDepth);
    return candidates;
  }
  function renderRunMap() {
    const wrap = document.getElementById('path-body');
    const m = meta();
    const next = availableNextNodes();
    const tiers = [[], [], [], [], []];
    RUN.nodes.forEach(n => tiers[n.tier].push(n));

    let mapHtml = '';
    for (let t = 4; t >= 0; t--) {
      const tierNodes = tiers[t].sort((a, b) => a.depth - b.depth);
      mapHtml += `<div class="path-tier">` + tierNodes.map(n => {
        const reachable = next.some(x => x.idx === n.idx);
        const isCurrent = RUN.pos >= 0 && RUN.nodes[RUN.pos].idx === n.idx;
        const st = n.cleared ? 'cleared' : (reachable ? 'reachable' : (isCurrent ? 'current' : 'locked'));
        return `<div class="path-node pn-${n.type} ${st}" data-idx="${n.idx}" title="${n.title}">
          <div class="pn-ic">${nodeIcon(n)}</div>
          <div class="pn-depth">${n.depth}</div>
          ${n.modifiers.length ? `<div class="pn-mod" title="${n.modifiers.map(x => MOD_LABEL[x]).join(', ')}">⚠${n.modifiers.length}</div>` : ''}
        </div>`;
      }).join('<div class="path-link"></div>') + `</div>`;
      if (t > 0) mapHtml += `<div class="path-tier-gap">▲</div>`;
    }

    wrap.innerHTML = `
      <div class="path-runbar">
        <span>💠 ${RUN.shards} shards</span><span>🪙 ${RUN.gold} gold</span>
        <span>⛰ Depth ${RUN.pos < 0 ? 0 : RUN.nodes[RUN.pos].depth}/25</span>
        <button class="path-abandon" id="path-abandon">Abandon</button>
      </div>
      <div class="path-team-strip" id="path-team-strip"></div>
      <div class="path-map">${mapHtml}</div>
      <div class="path-node-detail" id="path-node-detail">Select a glowing node to advance.</div>`;

    renderTeamStrip();
    wrap.querySelectorAll('.path-node.reachable').forEach(el => {
      el.addEventListener('click', () => showNodeDetail(parseInt(el.dataset.idx, 10)));
    });
    const ab = document.getElementById('path-abandon');
    if (ab) ab.addEventListener('click', abandonRun);
    saveRun();
  }
  function nodeIcon(n) {
    return ({ battle: '⚔', elite: '💀', rest: '🏕', reward: '🎁', boss: '☠' })[n.type] || '⚔';
  }
  function renderTeamStrip() {
    const strip = document.getElementById('path-team-strip');
    if (!strip || !RUN) return;
    strip.innerHTML = RUN.team.map(id => {
      const s = spirits().find(x => x.id === id);
      const hp = Math.round((RUN.teamHp[id] != null ? RUN.teamHp[id] : 1) * 100);
      const dead = hp <= 0;
      return `<div class="path-team-chip ${dead ? 'downed' : ''}">
        <span class="ptc-emoji">${s ? s.emoji : '?'}</span>
        <span class="ptc-hp">${dead ? 'DOWNED' : hp + '%'}</span></div>`;
    }).join('');
  }

  function showNodeDetail(idx) {
    const n = RUN.nodes[idx];
    const detail = document.getElementById('path-node-detail');
    let body = `<h4>${nodeIcon(n)} ${n.title}</h4>`;
    if (n.type === 'rest') {
      body += `<p>A safe wayshrine. Restore your team to full HP and mend the fallen.</p>
        <button class="path-go-btn" id="path-go">REST HERE</button>`;
    } else if (n.type === 'reward') {
      body += `<p>A cache of spirit-essence. Claim gold + shards without a fight.</p>
        <button class="path-go-btn" id="path-go">OPEN CACHE</button>`;
    } else if (n.type === 'boss') {
      const b = BOSSES[n.bossKey];
      body += `<p><b>${b.subtitle}</b><br>A mighty boss with ${b.hp} HP and deadly phase mechanics.</p>`;
      if (n.modifiers.length) body += `<p class="pnd-mods">Raid modifiers: ${n.modifiers.map(x => MOD_LABEL[x]).join(', ')}</p>`;
      body += `<button class="path-go-btn boss" id="path-go">CHALLENGE THE BOSS</button>`;
    } else {
      body += `<p>${n.enemyCount} enemies${n.type === 'elite' ? ' (Elite — tougher, +modifier)' : ''}.</p>`;
      if (n.modifiers.length) body += `<p class="pnd-mods">Raid modifiers: ${n.modifiers.map(x => MOD_LABEL[x]).join(', ')}</p>`;
      body += `<button class="path-go-btn" id="path-go">ENTER BATTLE</button>`;
    }
    detail.innerHTML = body;
    const go = document.getElementById('path-go');
    if (go) go.addEventListener('click', () => enterNode(idx));
  }

  // ── Node resolution ────────────────────────────────────────────────
  function enterNode(idx) {
    const n = RUN.nodes[idx];
    RUN.pendingNodeIdx = idx;
    saveRun();
    if (n.type === 'rest') {
      RUN.team.forEach(id => { RUN.teamHp[id] = 1; });
      n.cleared = true; RUN.pos = idx;
      toast('🏕 Your team rests and recovers fully.');
      saveRun(); renderRunMap();
      return;
    }
    if (n.type === 'reward') {
      const gold = 60 + n.depth * 6, shards = 8 + n.depth;
      RUN.gold += gold; RUN.shards += shards;
      if (P().grantGold) P().grantGold(gold);
      n.cleared = true; RUN.pos = idx;
      toast(`🎁 Cache: +${gold} gold, +${shards} shards.`);
      saveRun(); renderRunMap();
      return;
    }
    // Battle / elite / boss → launch a real battle through the engine.
    launchBattle(idx);
  }

  function launchBattle(idx) {
    const n = RUN.nodes[idx];
    const specs = buildEnemySpecs(n);
    const boss = n.type === 'boss' ? BOSSES[n.bossKey].mechanics : null;
    const bossDef = n.type === 'boss' ? Object.assign({ name: BOSSES[n.bossKey].name }, BOSSES[n.bossKey].mechanics) : null;

    if (!P().startPathBattle) { toast('Path engine unavailable'); return; }
    P().startPathBattle(RUN.team, specs, {
      boss: bossDef,
      modifiers: n.modifiers,
      node: { title: n.title, type: n.type, depth: n.depth },
      startHp: Object.assign({}, RUN.teamHp),   // survivor HP carry-over (attrition)
      onResult: (won, summary) => onBattleResult(idx, won, summary),
    });
  }

  function onBattleResult(idx, won, summary) {
    const n = RUN.nodes[idx];
    // Carry survivor HP back into the run (downed spirits are revived at rest nodes).
    const survivorMap = {};
    (summary.survivors || []).forEach(s => { survivorMap[s.id] = s.hpPct; });
    RUN.team.forEach(id => { RUN.teamHp[id] = (survivorMap[id] != null) ? survivorMap[id] : 0; });

    if (!won) { return finishRun(false, idx); }

    // Win: clear node, grant scaled gold + shards.
    n.cleared = true; RUN.pos = idx;
    const baseGold = (n.type === 'boss' ? 200 : n.type === 'elite' ? 90 : 50) + n.depth * 5;
    const baseShard = (n.type === 'boss' ? 40 : n.type === 'elite' ? 16 : 8) + Math.floor(n.depth / 2);
    RUN.gold += baseGold; RUN.shards += baseShard;
    if (P().grantGold) P().grantGold(baseGold);
    if (P().grantXP) P().grantXP(n.type === 'boss' ? 120 : 40);
    RUN.reachedDepth = Math.max(RUN.reachedDepth, n.depth);
    saveRun();

    if (n.depth >= 25) { return finishRun(true, idx); }

    showPathScreen();
    ensureUI();
    renderRunMap();
    document.getElementById('path-node-detail').innerHTML =
      `<h4>✦ ${n.title} cleared!</h4><p>+${baseGold} gold, +${baseShard} shards. Choose your next path.</p>`;
  }

  // ── Run end (victory or defeat) ────────────────────────────────────
  function finishRun(victory, idx) {
    RUN.finished = true;
    const depth = RUN.nodes[idx] ? RUN.nodes[idx].depth : RUN.reachedDepth;
    // Bank shards to the account meta (failed runs STILL grant meaningful progress).
    const banked = RUN.shards + (victory ? 60 : Math.floor(depth * 3));
    setMeta({
      shards: meta().shards + banked,
      runsCompleted: meta().runsCompleted + (victory ? 1 : 0),
      deepestDepth: Math.max(meta().deepestDepth, depth),
    });
    showPathScreen();
    ensureUI();
    const wrap = document.getElementById('path-body');
    if (victory) {
      const m = meta();
      const canClaim = !m.finalSpiritClaimed;
      const choices = canClaim ? rollFinalSpiritChoices() : [];
      wrap.innerHTML = `
        <div class="path-end win">
          <h2>✦ THE PATH IS CONQUERED ✦</h2>
          <p>You reached the end of the Long Path. Banked <b>${banked}</b> shards.</p>
          ${canClaim && choices.length ? `
            <h3>Claim your legendary spirit — choose one (once per account):</h3>
            <div class="path-final-choices" id="path-final-choices">
              ${choices.map(id => { const s = spirits().find(x => x.id === id); return `
                <div class="path-final-card" data-id="${id}">
                  <div class="pfc-emoji">${s.emoji}</div><div class="pfc-name">${s.name}</div>
                  <div class="pfc-cls cls-${s.cls}">${s.cls}</div>
                  <div class="pfc-stats">❤${s.hp} ⚔${s.atk} ⚡${s.spd}</div>
                  <button class="pfc-claim" data-id="${id}">CLAIM</button>
                </div>`; }).join('')}
            </div>` : `<p style="color:#7affb0;">You have already claimed the Path's legendary reward — enjoy the shards!</p>`}
          <button class="path-go-btn" id="path-finish-home">RETURN HOME</button>
        </div>`;
      if (canClaim) {
        wrap.querySelectorAll('.pfc-claim').forEach(b => b.addEventListener('click', () => claimFinalSpirit(b.dataset.id)));
      }
    } else {
      wrap.innerHTML = `
        <div class="path-end lose">
          <h2>The Path Claims You</h2>
          <p>Your expedition ends at depth <b>${depth}/25</b>. But your effort was not wasted —
          <b>${banked}</b> shards are banked to your account.</p>
          <button class="path-go-btn" id="path-finish-home">RETURN HOME</button>
          <button class="path-go-btn alt" id="path-retry">NEW EXPEDITION</button>
        </div>`;
      const rt = document.getElementById('path-retry');
      if (rt) rt.addEventListener('click', () => { clearRun(); renderRunSetup(); });
    }
    clearRun();
    const fh = document.getElementById('path-finish-home');
    if (fh) fh.addEventListener('click', () => { if (P().showHome) P().showHome(); });
  }

  function claimFinalSpirit(id) {
    const m = meta();
    if (m.finalSpiritClaimed) { toast('Already claimed.'); return; }
    const ok = P().unlockSpiritById && P().unlockSpiritById(id);
    const s = spirits().find(x => x.id === id);
    setMeta({ finalSpiritClaimed: true });
    toast(ok ? `✦ ${s.name} joins your roster forever!` : `${s.name} was already unlocked — shards granted instead.`);
    document.querySelectorAll('.pfc-claim').forEach(b => { b.disabled = true; b.textContent = b.dataset.id === id ? '✓ CLAIMED' : '—'; });
  }

  function abandonRun() {
    if (!confirm('Abandon this expedition? You keep the shards earned so far.')) return;
    const depth = RUN.pos < 0 ? 0 : RUN.nodes[RUN.pos].depth;
    setMeta({ shards: meta().shards + RUN.shards, deepestDepth: Math.max(meta().deepestDepth, depth) });
    clearRun();
    renderRunSetup();
  }

  // ── UI scaffolding (screen + CSS injected once) ────────────────────
  function ensureUI() {
    if (!document.getElementById('s-path')) {
      const screen = document.createElement('div');
      screen.className = 'screen hidden';
      screen.id = 's-path';
      screen.innerHTML = `
        <div class="path-header">
          <button class="btn-back" id="path-back">← Home</button>
          <h2>PATH EXPEDITION</h2>
        </div>
        <div class="path-body" id="path-body"></div>`;
      document.body.appendChild(screen);
      const back = document.getElementById('path-back');
      if (back) back.addEventListener('click', () => { if (P().showHome) P().showHome(); });
    }
    if (!document.getElementById('path-style')) injectCSS();
  }

  function injectCSS() {
    const st = document.createElement('style');
    st.id = 'path-style';
    st.textContent = `
      #s-path { flex-direction:column; align-items:center; overflow-y:auto; padding-bottom:40px; }
      .path-header { width:100%; max-width:920px; display:flex; align-items:center; gap:16px; padding:12px 0 8px; position:relative; }
      .path-header h2 { font-family:'Cinzel Decorative',serif; font-size:22px; color:#e8c56a; letter-spacing:3px; flex:1; text-align:center; }
      .path-body { width:100%; max-width:920px; }
      /* setup */
      .path-intro h3 { font-family:'Cinzel Decorative',serif; color:#e8c56a; letter-spacing:2px; text-align:center; }
      .path-intro p { color:#cfc8e6; font-size:13px; line-height:1.6; text-align:center; max-width:680px; margin:6px auto; }
      .path-meta-row { display:flex; gap:16px; justify-content:center; flex-wrap:wrap; font-size:12px; color:#9a92b5; margin:10px 0; }
      .path-meta-row b { color:#e8c56a; }
      .path-pick-title { text-align:center; color:#7fb0ff; font-family:'Rajdhani',sans-serif; letter-spacing:1px; font-size:13px; margin:14px 0 8px; }
      .path-pick-slots { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-bottom:14px; }
      .path-slot { position:relative; width:74px; height:88px; border:2px dashed rgba(255,255,255,0.14); border-radius:12px; display:flex;
        flex-direction:column; align-items:center; justify-content:center; gap:3px; }
      .path-slot.pf { border-color:rgba(232,197,106,0.5); } .path-slot.pb { border-color:rgba(90,150,232,0.45); }
      .path-slot.filled { background:rgba(255,255,255,0.04); border-style:solid; }
      .path-slot-tag { position:absolute; top:-8px; left:50%; transform:translateX(-50%); font-size:7px; font-family:'Cinzel Decorative',serif; letter-spacing:1px; padding:1px 6px; border-radius:50px; }
      .path-slot.pf .path-slot-tag { background:linear-gradient(135deg,#e8c56a,#caa23f); color:#1a1206; }
      .path-slot.pb .path-slot-tag { background:linear-gradient(135deg,#5a96e8,#2f5fa8); color:#dfeaff; }
      .pps-emoji { font-size:26px; } .pps-name { font-size:9px; color:#e8c56a; } .pps-plus { font-size:24px; color:#6b6685; }
      .path-pick-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(92px,1fr)); gap:8px; margin-bottom:16px; }
      .path-pick-card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:8px 4px; text-align:center; cursor:pointer; transition:all .15s; }
      .path-pick-card:hover { border-color:rgba(232,197,106,0.4); transform:translateY(-2px); }
      .path-pick-card.picked { border-color:#e8c56a; background:rgba(232,197,106,0.1); box-shadow:0 0 12px rgba(232,197,106,0.3); }
      .ppc-emoji { font-size:26px; } .ppc-name { font-size:11px; color:#e8e2f4; } .ppc-cls { font-size:9px; letter-spacing:1px; text-transform:uppercase; }
      .ppc-stats { font-size:9px; color:#9a92b5; margin-top:2px; }
      .cls-flame{color:#ff7a3c}.cls-water{color:#3ca6ff}.cls-earth{color:#c8a45a}.cls-storm{color:#a9d8ff}.cls-void{color:#b07cff}.cls-nature{color:#7affb0}
      .path-start-btn, .path-go-btn { display:block; margin:8px auto; padding:13px 40px; background:linear-gradient(135deg,#7b3fe0,#4a20a0);
        border:none; border-radius:50px; font-family:'Cinzel Decorative',serif; letter-spacing:2px; color:#fff; cursor:pointer; box-shadow:0 0 20px rgba(155,111,232,0.4); }
      .path-start-btn:disabled { opacity:.35; cursor:default; }
      .path-go-btn.boss { background:linear-gradient(135deg,#e8554f,#a01818); box-shadow:0 0 22px rgba(232,85,79,0.5); }
      .path-go-btn.alt { background:linear-gradient(135deg,#2a5c4a,#15402c); }
      /* run bar + team strip */
      .path-runbar { display:flex; gap:18px; align-items:center; justify-content:center; flex-wrap:wrap; font-size:13px; color:#e8c56a; margin:6px 0 12px; }
      .path-abandon { background:none; border:1px solid rgba(232,85,79,0.4); color:#e8857f; border-radius:50px; padding:4px 14px; cursor:pointer; font-size:11px; }
      .path-team-strip { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-bottom:14px; }
      .path-team-chip { display:flex; flex-direction:column; align-items:center; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1);
        border-radius:10px; padding:6px 12px; min-width:54px; }
      .path-team-chip.downed { opacity:.4; border-color:rgba(232,85,79,0.4); }
      .ptc-emoji { font-size:22px; } .ptc-hp { font-size:10px; color:#7affb0; } .path-team-chip.downed .ptc-hp { color:#e8857f; }
      /* map */
      .path-map { display:flex; flex-direction:column; align-items:center; gap:2px; }
      .path-tier { display:flex; gap:18px; align-items:center; justify-content:center; }
      .path-tier-gap { color:#4a4660; font-size:14px; margin:1px 0; }
      .path-node { position:relative; width:60px; height:60px; border-radius:14px; background:rgba(255,255,255,0.03);
        border:2px solid rgba(255,255,255,0.1); display:flex; flex-direction:column; align-items:center; justify-content:center; transition:all .15s; }
      .path-node.locked { opacity:.4; }
      .path-node.cleared { border-color:rgba(125,255,176,0.5); background:rgba(125,255,176,0.07); }
      .path-node.reachable { cursor:pointer; border-color:#e8c56a; box-shadow:0 0 16px rgba(232,197,106,0.4); animation:pathPulse 1.8s ease-in-out infinite; }
      @keyframes pathPulse { 0%,100%{box-shadow:0 0 12px rgba(232,197,106,0.3);} 50%{box-shadow:0 0 22px rgba(232,197,106,0.6);} }
      .path-node.reachable:hover { transform:scale(1.08); }
      .path-node.pn-boss { border-radius:50%; border-color:rgba(232,85,79,0.5); background:rgba(232,85,79,0.08); width:66px; height:66px; }
      .path-node.pn-boss.reachable { border-color:#e8554f; box-shadow:0 0 18px rgba(232,85,79,0.5); }
      .pn-ic { font-size:22px; } .pn-depth { font-size:9px; color:#9a92b5; }
      .pn-mod { position:absolute; top:-6px; right:-6px; background:#e8a23f; color:#1a1206; font-size:9px; font-weight:700; border-radius:50px; padding:0 4px; }
      .path-link { width:18px; height:2px; background:rgba(255,255,255,0.1); }
      .path-node-detail { max-width:560px; margin:16px auto 0; text-align:center; background:rgba(255,255,255,0.03);
        border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:16px; color:#cfc8e6; font-size:13px; }
      .path-node-detail h4 { font-family:'Cinzel Decorative',serif; color:#e8c56a; margin-bottom:6px; }
      .pnd-mods { color:#e8a23f; font-size:12px; }
      /* end screens */
      .path-end { text-align:center; padding:30px 16px; }
      .path-end h2 { font-family:'Cinzel Decorative',serif; letter-spacing:2px; }
      .path-end.win h2 { color:#e8c56a; filter:drop-shadow(0 0 16px rgba(232,197,106,0.5)); }
      .path-end.lose h2 { color:#e8857f; }
      .path-end p { color:#cfc8e6; max-width:560px; margin:10px auto; line-height:1.6; }
      .path-end h3 { color:#7fb0ff; font-family:'Rajdhani',sans-serif; letter-spacing:1px; margin-top:16px; }
      .path-final-choices { display:flex; gap:14px; justify-content:center; flex-wrap:wrap; margin:14px 0; }
      .path-final-card { background:rgba(255,255,255,0.04); border:1px solid rgba(232,197,106,0.3); border-radius:14px; padding:14px 16px; width:160px; }
      .pfc-emoji { font-size:40px; } .pfc-name { font-family:'Cinzel Decorative',serif; color:#e8c56a; font-size:14px; margin:4px 0; }
      .pfc-cls { font-size:10px; letter-spacing:1px; text-transform:uppercase; } .pfc-stats { font-size:10px; color:#9a92b5; margin:6px 0; }
      .pfc-claim { background:linear-gradient(135deg,#e8c56a,#caa23f); color:#1a1206; border:none; border-radius:8px; padding:8px 16px; font-weight:700; cursor:pointer; font-family:'Rajdhani',sans-serif; letter-spacing:1px; }
      .pfc-claim:disabled { background:rgba(255,255,255,0.1); color:#7affb0; cursor:default; }
    `;
    document.head.appendChild(st);
  }

  // ── Co-op stub (v1 = solo; co-op is a focused follow-up) ───────────
  // The map is seed-based and the engine bridge is host-authoritative-ready,
  // so co-op = (1) share RUN.seed + team via the existing room-code channel,
  // (2) both clients generateMap(seed) → identical map, (3) host runs the
  // battle authoritatively (already how ranked MP works), (4) anti-carry:
  // rewards split + per-player downed tracking. Exposed for later wiring.
  window.PathCoop = {
    serializeRun: () => RUN ? { seed: RUN.seed, team: RUN.team, pos: RUN.pos } : null,
    adoptRun: (data) => { if (data && data.seed) { RUN = { seed: data.seed, nodes: generateMap(data.seed), pos: data.pos != null ? data.pos : -1, team: data.team, gold: 0, shards: 0, fragments: 0, finished: false, reachedDepth: 0, teamHp: {} }; data.team.forEach(id => RUN.teamHp[id] = 1); saveRun(); } },
  };

  window.PathExpedition = PathExpedition;
})();
