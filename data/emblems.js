// ════════════════════════════════════════════════════════════════════
// EMBLEMS + LOOT CASES — full implementation (Phase A + B + Mythic tier)
// Loaded as a plain <script> before index.html's inline script.
//
// Hook triggers used in this file:
//   battleStart, turnStart, turnEnd, roundEnd
//   onDamageDealt(side,{attacker,target,card,bonusDmg,isCrit})
//   onDamageTaken(side,{target,attacker,dmg,raw})
//   onCrit(side,{attacker,target,card,bonusDmg})
//   onKill(side,{attacker,victim,card})
//   onDeath(side,{victim})
//   onHeal(side,{healer,target,amount,card})
//   modifyHealAmount(side,{healer,target,amount,card})
//   modifyShieldAmount(side,{caster,target,amount,card})
//   onShieldGained(side,{caster,target,amount,card})
//   onApplyBurn(side,{attacker,target,effect})
//   onApplyStun(side,{attacker,target,effect})
//   modifyIncomingDamage(side,dmg,{target,attacker})  -> number
//   modifyCardCost(side,{card,cardIdx,owner,cost})    -> mutate ctx.cost
//   onCardPlayed(side,{attacker,card,target})
//
// Manual abilities (once-per-battle, player-triggered) use `manualAbility`:
//   { buttonLabel:'…', canActivate:(side)=>bool, activate:(side)=>{} }
// ════════════════════════════════════════════════════════════════════

const EMBLEM_RARITY_META = {
  common:    { label:'Common',    color:'#9ca3af', glow:'rgba(156,163,175,0.35)', weight:55 },
  rare:      { label:'Rare',      color:'#5ab4e8', glow:'rgba(90,180,232,0.55)',  weight:30 },
  epic:      { label:'Epic',      color:'#9b6fe8', glow:'rgba(155,111,232,0.65)', weight:12 },
  prismatic: { label:'Prismatic', color:'#e8c56a', glow:'rgba(232,197,106,0.85)', weight:3  },
  mythic:    { label:'Mythic',    color:'#ff6ec7', glow:'rgba(255,110,199,0.95)', weight:1  },
};
const CLASS_GLYPH = { flame:'🔥', water:'💧', nature:'🍃', storm:'⚡', void:'🌑', earth:'🪨', arcane:'✨' };

// Per-battle scratch space accessor — bridge to G.emblemRuntime initialized in initState().
function emRuntime(side) {
  if (!G || !G.emblemRuntime) return { used:{}, counters:{}, flags:{}, stats:{} };
  return G.emblemRuntime[side];
}

function mkE(id, name, cls, rarity, desc, hooks, manualAbility) {
  return { id, name, class:cls, rarity, description:desc, hooks: hooks||{}, manualAbility: manualAbility||null };
}

const EMBLEMS = [
  // ═══════════════════════════════════════════════════════════
  // FLAME
  // ═══════════════════════════════════════════════════════════
  mkE('flame_common_1', 'Ember Core', 'flame', 'common',
    'Burn effects deal +2 extra damage per tick',
    { onApplyBurn: (side, ctx) => { ctx.effect.val = (ctx.effect.val||0) + 2; } }),
  mkE('flame_common_2', 'Kindle', 'flame', 'common',
    'Your spirits start each battle with +15 HP',
    { battleStart: (side, ctx) => { for (const c of ctx.team) { c.maxHp += 15; c.hp += 15; } } }),
  mkE('flame_common_3', 'Scorch Mark', 'flame', 'common',
    'Attacks have a 10% chance to apply Burn (1 turn, 12 dmg)',
    { onDamageDealt: (side, ctx) => {
        if (ctx.card.type !== 'damage' && ctx.card.type !== 'drain') return;
        if (ctx.target.dead) return;
        if (Math.random() < 0.10 && !ctx.target.effects.find(e=>e.type==='burn')) {
          ctx.target.effects.push({ type:'burn', val:12, turns:1, turnsLeft:1, _src:'emblem' });
          addLog(`🔥 Scorch Mark ignites ${ctx.target.name}!`, 'warn');
        }
    } }),
  mkE('flame_common_4', 'Flame Touched', 'flame', 'common',
    'Heal 5 HP whenever you apply a Burn effect',
    { onApplyBurn: (side, ctx) => {
        if (ctx.attacker && !ctx.attacker.dead) ctx.attacker.hp = Math.min(ctx.attacker.maxHp, ctx.attacker.hp + 5);
    } }),

  mkE('flame_rare_1', 'Inferno Pulse', 'flame', 'rare',
    'On kill, all remaining enemy spirits take 15 fire damage',
    { onKill: (side, ctx) => {
        const enemyTeam = side === 'player' ? G.enemyTeam : G.playerTeam;
        for (const c of enemyTeam) {
          if (!c.dead && c !== ctx.victim) { applyDamage(c, 15); shakeEl(c); }
        }
        addLog(`🔥 Inferno Pulse scorches the survivors!`, 'warn');
    } }),
  mkE('flame_rare_2', 'Heat Sink', 'flame', 'rare',
    'Your spirits take 8% less damage from non-flame attackers',
    { modifyIncomingDamage: (side, dmg, ctx) =>
        ctx.attacker && ctx.attacker.cls !== 'flame' ? Math.round(dmg * 0.92) : dmg
    }),
  mkE('flame_rare_3', 'Backdraft', 'flame', 'rare',
    '20% of damage you receive is reflected back as Burn (2 turns)',
    { onDamageTaken: (side, ctx) => {
        if (!ctx.attacker || ctx.attacker.dead) return;
        const burnDmg = Math.max(3, Math.round(ctx.dmg * 0.20));
        if (!ctx.attacker.effects.find(e=>e._src==='backdraft')) {
          ctx.attacker.effects.push({ type:'burn', val:burnDmg, turns:2, turnsLeft:2, _src:'backdraft' });
          addLog(`🔥 Backdraft sears ${ctx.attacker.name} for ${burnDmg}/turn!`, 'warn');
        }
    } }),
  mkE('flame_rare_4', 'Cinder Rush', 'flame', 'rare',
    'Your first card each battle costs 0 energy',
    { battleStart: (side) => { emRuntime(side).flags.cinderRush = true; },
      modifyCardCost: (side, ctx) => {
        if (emRuntime(side).flags.cinderRush) ctx.cost = 0;
      },
      onCardPlayed: (side) => {
        const rt = emRuntime(side);
        if (rt.flags.cinderRush) { rt.flags.cinderRush = false; addLog(`🔥 Cinder Rush expended.`, ''); }
    } }),

  mkE('flame_epic_1', 'Pyre Ascension', 'flame', 'epic',
    'Consecutive attacks by the same spirit deal +3 dmg each (resets on switch)',
    { onDamageDealt: (side, ctx) => {
        if (ctx.card.type !== 'damage' && ctx.card.type !== 'drain') return;
        const rt = emRuntime(side);
        if (rt.stats.pyreLast === ctx.attacker.id) {
          rt.stats.pyreStacks = (rt.stats.pyreStacks||0) + 1;
        } else {
          rt.stats.pyreLast = ctx.attacker.id;
          rt.stats.pyreStacks = 0;
        }
        ctx.bonusDmg = (ctx.bonusDmg||0) + rt.stats.pyreStacks * 3;
        if (rt.stats.pyreStacks > 0) addLog(`🔥 Pyre Ascension ×${rt.stats.pyreStacks}`, 'em');
    } }),
  mkE('flame_epic_2', 'Molten Core', 'flame', 'epic',
    'When any spirit drops below 30% HP, ALL your spirits gain +25% ATK for the battle',
    { onDamageTaken: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.moltenCore) return;
        if (ctx.target.hp > 0 && ctx.target.hp < ctx.target.maxHp * 0.30) {
          rt.flags.moltenCore = true;
          const team = side === 'player' ? G.playerTeam : G.enemyTeam;
          for (const c of team) if (!c.dead) c.atkMod = (c.atkMod||1) * 1.25;
          addLog(`🔥 MOLTEN CORE awakens! +25% ATK to your spirits.`, 'crit');
        }
    } }),

  mkE('flame_prismatic_1', 'Ragnarok Seal', 'flame', 'prismatic',
    'Every 3rd card you play costs 0 energy',
    { battleStart: (side) => { emRuntime(side).counters.ragnarok = 0; },
      modifyCardCost: (side, ctx) => {
        const rt = emRuntime(side);
        if ((rt.counters.ragnarok || 0) % 3 === 2) ctx.cost = 0;
      },
      onCardPlayed: (side) => {
        const rt = emRuntime(side);
        rt.counters.ragnarok = (rt.counters.ragnarok||0) + 1;
        if (rt.counters.ragnarok % 3 === 0) addLog(`✨ Ragnarok Seal — free strike charged.`, 'warn');
    } }),
  mkE('flame_prismatic_2', 'Solar Collapse', 'flame', 'prismatic',
    'When you first drop below 20% HP, automatically deal an 80-dmg burst to a random enemy',
    { onDamageTaken: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.solarCollapseFired) return;
        if (ctx.target.hp > 0 && ctx.target.hp < ctx.target.maxHp * 0.20) {
          rt.flags.solarCollapseFired = true;
          const foes = (side === 'player' ? G.enemyTeam : G.playerTeam).filter(c=>!c.dead);
          if (foes.length) {
            const t = foes[Math.floor(Math.random()*foes.length)];
            applyDamage(t, 80, ctx.target, true);
            shakeEl(t);
            addLog(`☀ SOLAR COLLAPSE detonates on ${t.name} for 80!`, 'crit');
          }
        }
    } }),

  // ═══════════════════════════════════════════════════════════
  // WATER
  // ═══════════════════════════════════════════════════════════
  mkE('water_common_1', 'Tidal Mend', 'water', 'common',
    'Heal 8 HP per spirit at the end of every round',
    { roundEnd: (side, ctx) => { for (const c of ctx.team) if (!c.dead) c.hp = Math.min(c.maxHp, c.hp + 8); } }),
  mkE('water_common_2', 'Cold Current', 'water', 'common',
    'Freeze/Stun durations extended by 1 turn',
    { onApplyStun: (side, ctx) => { ctx.effect.turns += 1; ctx.effect.turnsLeft += 1; } }),
  mkE('water_common_3', 'Mist Veil', 'water', 'common',
    'Take 5% less damage',
    { modifyIncomingDamage: (side, dmg) => Math.round(dmg * 0.95) }),
  mkE('water_common_4', 'Ripple', 'water', 'common',
    'Attacks have 8% chance to apply Freeze (1 turn)',
    { onDamageDealt: (side, ctx) => {
        if (ctx.card.type !== 'damage' && ctx.card.type !== 'drain') return;
        if (ctx.target.dead) return;
        if (Math.random() < 0.08 && !ctx.target.effects.find(e=>e.type==='stun')) {
          ctx.target.effects.push({ type:'stun', turns:1, turnsLeft:1, _src:'emblem', _label:'Freeze' });
          addLog(`❄ Ripple freezes ${ctx.target.name}!`, 'warn');
        }
    } }),

  mkE('water_rare_1', 'Undertow', 'water', 'rare',
    'Opponent SPD reduced by 10% while any of them is Frozen/Stunned',
    { onApplyStun: (side, ctx) => {
        if (ctx.target._undertowApplied) return;
        ctx.target._undertowApplied = true;
        ctx.target.spd = Math.max(20, Math.round((ctx.target.spd||60) * 0.9));
    } }),
  mkE('water_rare_2', 'Glacial Armor', 'water', 'rare',
    'Each of your spirits starts with +20 shield',
    { battleStart: (side, ctx) => { for (const c of ctx.team) c.shield = Math.min(200, (c.shield||0) + 20); } }),
  mkE('water_rare_3', 'Deep Pressure', 'water', 'rare',
    'Your shield cards grant 15% more shield',
    { modifyShieldAmount: (side, ctx) => { ctx.amount = Math.round(ctx.amount * 1.15); } }),
  mkE('water_rare_4', 'Riptide', 'water', 'rare',
    'After using a heal card, your next attack deals +20 damage',
    { onHeal: (side) => { emRuntime(side).flags.riptide = true; },
      onDamageDealt: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.riptide && (ctx.card.type === 'damage' || ctx.card.type === 'drain')) {
          ctx.bonusDmg = (ctx.bonusDmg||0) + 20;
          rt.flags.riptide = false;
          addLog(`🌊 Riptide bonus damage!`, 'em');
        }
    } }),

  mkE('water_epic_1', 'Abyssal Veil', 'water', 'epic',
    'Once per battle, automatically survive a killing blow with 1 HP',
    { onDamageTaken: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.abyssalUsed) return;
        if (ctx.target.hp <= 0) {
          ctx.target.hp = 1;
          rt.flags.abyssalUsed = true;
          addLog(`🌊 Abyssal Veil saves ${ctx.target.name} at 1 HP!`, 'warn');
        }
    } }),
  mkE('water_epic_2', 'Tidal Surge', 'water', 'epic',
    'Every 4th round, deal 25 dmg automatically to a random enemy',
    { roundEnd: (side) => {
        const rt = emRuntime(side);
        rt.counters.tidalSurge = (rt.counters.tidalSurge||0) + 1;
        if (rt.counters.tidalSurge % 4 === 0) {
          const foes = (side === 'player' ? G.enemyTeam : G.playerTeam).filter(c=>!c.dead);
          if (foes.length) {
            const t = foes[Math.floor(Math.random()*foes.length)];
            applyDamage(t, 25);
            addLog(`🌊 Tidal Surge crashes on ${t.name}!`, 'warn');
          }
        }
    } }),

  mkE('water_prismatic_1', 'Maelstrom', 'water', 'prismatic',
    'Every attack has 15% chance to Freeze the target (any card type)',
    { onDamageDealt: (side, ctx) => {
        if (ctx.target.dead) return;
        if (Math.random() < 0.15 && !ctx.target.effects.find(e=>e.type==='stun')) {
          ctx.target.effects.push({ type:'stun', turns:1, turnsLeft:1, _src:'emblem', _label:'Freeze' });
          addLog(`❄ MAELSTROM freezes ${ctx.target.name}!`, 'warn');
        }
    } }),
  mkE('water_prismatic_2', "Leviathan's Blessing", 'water', 'prismatic',
    'Your heals also restore HP to the next ally (50% overflow)',
    { onHeal: (side, ctx) => {
        const team = side === 'player' ? G.playerTeam : G.enemyTeam;
        const idx = team.indexOf(ctx.target);
        if (idx < 0) return;
        for (let i = idx + 1; i < team.length; i++) {
          const next = team[i];
          if (!next.dead) {
            const over = Math.round(ctx.amount * 0.5);
            next.hp = Math.min(next.maxHp, next.hp + over);
            addLog(`🌊 Leviathan's Blessing overflows: ${next.name} +${over} HP`, 'em');
            return;
          }
        }
    } }),

  // ═══════════════════════════════════════════════════════════
  // NATURE
  // ═══════════════════════════════════════════════════════════
  mkE('nature_common_1', 'Root Bind', 'nature', 'common',
    'Poison effects deal +2 extra damage per tick',
    { onApplyBurn: (side, ctx) => { ctx.effect.val = (ctx.effect.val||0) + 2; } }),
  mkE('nature_common_2', 'Verdant Skin', 'nature', 'common',
    'Start each battle with +20 HP',
    { battleStart: (side, ctx) => { for (const c of ctx.team) { c.maxHp += 20; c.hp += 20; } } }),
  mkE('nature_common_3', 'Spore Cloud', 'nature', 'common',
    '10% chance on attack to apply Poison (2 turns, 10 dmg)',
    { onDamageDealt: (side, ctx) => {
        if (ctx.card.type !== 'damage' && ctx.card.type !== 'drain') return;
        if (ctx.target.dead) return;
        if (Math.random() < 0.10 && !ctx.target.effects.find(e=>e.type==='burn')) {
          ctx.target.effects.push({ type:'burn', val:10, turns:2, turnsLeft:2, _src:'emblem', _label:'Poison' });
          addLog(`☠ Spore Cloud poisons ${ctx.target.name}!`, 'warn');
        }
    } }),
  mkE('nature_common_4', 'Photosynthesis', 'nature', 'common',
    'Heal 6 HP at the start of your turn if any spirit is below 50%',
    { turnStart: (side, ctx) => {
        for (const c of ctx.team) if (!c.dead && c.hp < c.maxHp * 0.5) c.hp = Math.min(c.maxHp, c.hp + 6);
    } }),

  mkE('nature_rare_1', 'Overgrowth', 'nature', 'rare',
    'Healing cards restore 20% more HP',
    { modifyHealAmount: (side, ctx) => { ctx.amount = Math.round(ctx.amount * 1.20); } }),
  mkE('nature_rare_2', 'Thornwall', 'nature', 'rare',
    'Attackers take 8 damage when they hit your spirit',
    { onDamageTaken: (side, ctx) => {
        if (!ctx.attacker || ctx.attacker.dead) return;
        applyDamage(ctx.attacker, 8);
        addLog(`🌿 Thornwall pricks ${ctx.attacker.name} for 8!`, '');
    } }),
  mkE('nature_rare_3', 'Ancient Bark', 'nature', 'rare',
    'Reduce all incoming damage by a flat 5',
    { modifyIncomingDamage: (side, dmg) => Math.max(0, dmg - 5) }),
  mkE('nature_rare_4', 'Symbiosis', 'nature', 'rare',
    'When a spirit dies, the next living one gains +30 HP (permanently)',
    { onDeath: (side, ctx) => {
        const team = side === 'player' ? G.playerTeam : G.enemyTeam;
        const idx = team.indexOf(ctx.victim);
        for (let i = idx + 1; i < team.length; i++) {
          if (!team[i].dead) {
            team[i].maxHp += 30; team[i].hp += 30;
            addLog(`🌿 Symbiosis empowers ${team[i].name}: +30 HP`, 'em');
            return;
          }
        }
    } }),

  mkE('nature_epic_1', 'Wildbloom', 'nature', 'epic',
    'Every 3 rounds, heal the most injured spirit for 40 HP',
    { roundEnd: (side, ctx) => {
        const rt = emRuntime(side);
        rt.counters.wildbloom = (rt.counters.wildbloom||0) + 1;
        if (rt.counters.wildbloom % 3 !== 0) return;
        let worst = null, worstFrac = 1;
        for (const c of ctx.team) {
          if (!c.dead && c.hp < c.maxHp) {
            const frac = c.hp / c.maxHp;
            if (frac < worstFrac) { worstFrac = frac; worst = c; }
          }
        }
        if (worst) {
          worst.hp = Math.min(worst.maxHp, worst.hp + 40);
          addLog(`🌿 Wildbloom heals ${worst.name} +40 HP`, 'em');
        }
    } }),
  mkE('nature_epic_2', 'Plague Root', 'nature', 'epic',
    'Poison you apply lasts +2 extra turns',
    { onApplyBurn: (side, ctx) => { ctx.effect.turns += 2; ctx.effect.turnsLeft += 2; } }),

  mkE('nature_prismatic_1', 'World Tree', 'nature', 'prismatic',
    'Once per battle, revive a fallen spirit with 40% HP (manual)',
    {},
    {
      buttonLabel: 'REVIVE',
      canActivate: (side) => {
        const team = side === 'player' ? G.playerTeam : G.enemyTeam;
        return team.some(c => c.dead);
      },
      activate: (side) => {
        const team = side === 'player' ? G.playerTeam : G.enemyTeam;
        const fallen = team.find(c => c.dead);
        if (!fallen) return;
        fallen.dead = false;
        fallen.reviveUsed = true;
        fallen.hp = Math.round(fallen.maxHp * 0.40);
        fallen.shield = 0;
        fallen.effects = [];
        addLog(`🌟 WORLD TREE blooms — ${fallen.name} returns!`, 'crit');
        renderBattle();
    } }),
  mkE('nature_prismatic_2', 'Verdant Collapse', 'nature', 'prismatic',
    'When your spirit dies, poison all enemies (15 dmg/turn × 3)',
    { onDeath: (side) => {
        const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
        for (const c of foes) {
          if (!c.dead && !c.effects.find(e=>e._src==='verdantCollapse')) {
            c.effects.push({ type:'burn', val:15, turns:3, turnsLeft:3, _src:'verdantCollapse', _label:'Poison' });
          }
        }
        addLog(`☠ VERDANT COLLAPSE — final poison wave!`, 'crit');
    } }),

  // ═══════════════════════════════════════════════════════════
  // STORM
  // ═══════════════════════════════════════════════════════════
  mkE('storm_common_1', 'Static Charge', 'storm', 'common',
    '+5% crit chance on all attacks',
    { battleStart: (side) => {
        if (side === 'player') G.playerCritBonus = (G.playerCritBonus||0) + 0.05;
        else                   G.enemyCritBonus  = (G.enemyCritBonus||0)  + 0.05;
    } }),
  mkE('storm_common_2', 'Tailwind', 'storm', 'common',
    'Gain +2 energy on your first turn',
    { battleStart: (side) => { if (side === 'player') G.energy = Math.min(G.maxEnergy + 2, G.energy + 2); } }),
  mkE('storm_common_3', 'Spark Gap', 'storm', 'common',
    'Crits deal +10 extra damage',
    { onCrit: (side, ctx) => { ctx.bonusDmg = (ctx.bonusDmg||0) + 10; } }),
  mkE('storm_common_4', 'Gale Step', 'storm', 'common',
    '+8 SPD permanently for all your spirits',
    { battleStart: (side, ctx) => { for (const c of ctx.team) c.spd = (c.spd||0) + 8; } }),

  mkE('storm_rare_1', 'Chain Lightning', 'storm', 'rare',
    'Crits have 25% chance to strike a second target for 50% damage',
    { onCrit: (side, ctx) => {
        if (Math.random() >= 0.25) return;
        const foes = (side === 'player' ? G.enemyTeam : G.playerTeam).filter(c => !c.dead && c !== ctx.target);
        if (!foes.length) return;
        const t = foes[Math.floor(Math.random()*foes.length)];
        const dmg = Math.round((ctx.card.power || 60) * 0.5);
        applyDamage(t, dmg, ctx.attacker);
        shakeEl(t);
        addLog(`⚡ Chain Lightning arcs to ${t.name} for ${dmg}!`, 'em');
    } }),
  mkE('storm_rare_2', 'Thunder Clap', 'storm', 'rare',
    'Once per battle: your first crit stuns the target for 1 turn',
    { onCrit: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.thunderClapUsed) return;
        rt.flags.thunderClapUsed = true;
        if (!ctx.target.effects.find(e=>e.type==='stun')) {
          ctx.target.effects.push({ type:'stun', turns:1, turnsLeft:1, _src:'emblem' });
          addLog(`⚡ Thunder Clap stuns ${ctx.target.name}!`, 'warn');
        }
    } }),
  mkE('storm_rare_3', 'Eye of the Storm', 'storm', 'rare',
    'After being stunned, gain +20% ATK for 2 turns',
    { turnStart: (side, ctx) => {
        const rt = emRuntime(side);
        for (const c of ctx.team) {
          if (rt.flags['eotsPending_'+c.id] && !c.effects.some(e=>e.type==='stun')) {
            // Recovered from stun — apply 2-turn buff
            c.atkMod = (c.atkMod||1) * 1.2;
            rt.flags['eotsBuffLeft_'+c.id] = 2;
            delete rt.flags['eotsPending_'+c.id];
            addLog(`⚡ ${c.name} surges from the eye of the storm — +20% ATK!`, 'em');
          } else if (rt.flags['eotsBuffLeft_'+c.id]) {
            rt.flags['eotsBuffLeft_'+c.id] -= 1;
            if (rt.flags['eotsBuffLeft_'+c.id] <= 0) {
              c.atkMod = c.atkMod / 1.2;
              delete rt.flags['eotsBuffLeft_'+c.id];
            }
          }
          // Flag spirits currently stunned for the next recovery turn
          if (c.effects.some(e=>e.type==='stun')) rt.flags['eotsPending_'+c.id] = true;
        }
    } }),
  mkE('storm_rare_4', 'Discharge', 'storm', 'rare',
    'Every 5th attack is a guaranteed crit',
    { onDamageDealt: (side, ctx) => {
        if (ctx.card.type !== 'damage' && ctx.card.type !== 'drain') return;
        const rt = emRuntime(side);
        rt.counters.discharge = (rt.counters.discharge||0) + 1;
        // Hard to retro-crit the in-progress attack, so we charge a bonus dmg burst instead
        if (rt.counters.discharge % 5 === 0) {
          ctx.bonusDmg = (ctx.bonusDmg||0) + Math.round((ctx.card.power||60) * 0.5);
          addLog(`⚡ Discharge — 5th-strike burst!`, 'crit');
        }
    } }),

  mkE('storm_epic_1', 'Stormbreaker', 'storm', 'epic',
    'Crit chance increases by +2% each round (stacks)',
    { roundEnd: (side) => {
        if (side === 'player') G.playerCritBonus = (G.playerCritBonus||0) + 0.02;
        else                   G.enemyCritBonus  = (G.enemyCritBonus||0)  + 0.02;
    } }),
  mkE('storm_epic_2', 'Voltage Surge', 'storm', 'epic',
    'After landing 3 crits, your next card costs 0 energy',
    { onCrit: (side) => {
        const rt = emRuntime(side);
        rt.counters.voltageCrits = (rt.counters.voltageCrits||0) + 1;
        if (rt.counters.voltageCrits === 3) {
          rt.flags.voltageReady = true;
          addLog(`⚡ Voltage Surge charged — next card free!`, 'warn');
        }
    },
      modifyCardCost: (side, ctx) => {
        if (emRuntime(side).flags.voltageReady) ctx.cost = 0;
    },
      onCardPlayed: (side) => {
        const rt = emRuntime(side);
        if (rt.flags.voltageReady) { rt.flags.voltageReady = false; rt.counters.voltageCrits = 0; }
    } }),

  mkE('storm_prismatic_1', 'Godstrike', 'storm', 'prismatic',
    'Once per battle (manual): next attack is a guaranteed crit with DOUBLE damage',
    {
      onDamageDealt: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.godstrikeArmed && (ctx.card.type === 'damage' || ctx.card.type === 'drain')) {
          ctx.bonusDmg = (ctx.bonusDmg||0) + Math.round(ctx.card.power || 80);
          rt.flags.godstrikeArmed = false;
          if (side === 'player') G.playerCritBonus = Math.max(0, G.playerCritBonus - 1.0);
          else                   G.enemyCritBonus  = Math.max(0, G.enemyCritBonus  - 1.0);
          addLog(`⚡ GODSTRIKE delivered!`, 'crit');
        }
      }
    },
    {
      buttonLabel: 'ARM',
      canActivate: (side) => !emRuntime(side).flags.godstrikeArmed,
      activate: (side) => {
        emRuntime(side).flags.godstrikeArmed = true;
        if (side === 'player') G.playerCritBonus = (G.playerCritBonus||0) + 1.0;
        else                   G.enemyCritBonus  = (G.enemyCritBonus||0)  + 1.0;
        addLog(`⚡ Godstrike armed — next attack will crit and hit twice as hard!`, 'warn');
    } }),
  mkE('storm_prismatic_2', 'Tempest Form', 'storm', 'prismatic',
    'Once per battle (manual): 3 turns where all your attacks are guaranteed crits',
    { turnStart: (side) => {
        const rt = emRuntime(side);
        if (!rt.counters.tempestTurnsLeft) return;
        rt.counters.tempestTurnsLeft -= 1;
        if (rt.counters.tempestTurnsLeft <= 0) {
          if (side === 'player') G.playerCritBonus = Math.max(0, (G.playerCritBonus||0) - 1.0);
          else                   G.enemyCritBonus  = Math.max(0, (G.enemyCritBonus||0)  - 1.0);
          addLog(`⛈ Tempest Form fades.`, '');
        }
    } },
    {
      buttonLabel: 'TEMPEST',
      activate: (side) => {
        emRuntime(side).counters.tempestTurnsLeft = 3;
        if (side === 'player') G.playerCritBonus = (G.playerCritBonus||0) + 1.0;
        else                   G.enemyCritBonus  = (G.enemyCritBonus||0)  + 1.0;
        addLog(`⛈ TEMPEST FORM — 3 turns of guaranteed crits!`, 'crit');
    } }),

  // ═══════════════════════════════════════════════════════════
  // VOID
  // ═══════════════════════════════════════════════════════════
  mkE('void_common_1', 'Shadow Veil', 'void', 'common',
    'Take 5% less damage',
    { modifyIncomingDamage: (side, dmg) => Math.round(dmg * 0.95) }),
  mkE('void_common_2', 'Null Touch', 'void', 'common',
    '10% chance on attack to stun all enemy spirits for 1 turn',
    { onDamageDealt: (side, ctx) => {
        if (ctx.card.type !== 'damage' && ctx.card.type !== 'drain') return;
        if (Math.random() < 0.10) {
          const enemyTeam = side === 'player' ? G.enemyTeam : G.playerTeam;
          for (const c of enemyTeam) {
            if (!c.dead && !c.effects.find(e=>e.type==='stun')) {
              c.effects.push({ type:'stun', turns:1, turnsLeft:1, _src:'emblem' });
            }
          }
          addLog(`🌑 Null Touch silences the enemy turn!`, 'warn');
        }
    } }),
  mkE('void_common_3', 'Dark Pact', 'void', 'common',
    'Deal +8 damage but take +4 damage',
    { onDamageDealt: (side, ctx) => { ctx.bonusDmg = (ctx.bonusDmg||0) + 8; },
      modifyIncomingDamage: (side, dmg) => dmg + 4 }),
  mkE('void_common_4', 'Silence', 'void', 'common',
    "Opponent's energy regen reduced by 1",
    { battleStart: (side) => {
        if (side === 'player') G.silenceOnEnemy = (G.silenceOnEnemy||0) + 1;
        else                   G.silenceOnPlayer = (G.silenceOnPlayer||0) + 1;
    } }),

  mkE('void_rare_1', 'Dread Aura', 'void', 'rare',
    "Opponents cannot heal above 60% of their max HP",
    { roundEnd: (side) => {
        const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
        for (const c of foes) {
          if (!c.dead && c.hp > c.maxHp * 0.60) {
            c.hp = Math.round(c.maxHp * 0.60);
          }
        }
    } }),
  mkE('void_rare_2', 'Void Step', 'void', 'rare',
    'Once per battle, automatically dodge the next hit that would drop you below 40% HP',
    { onDamageTaken: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.voidStepUsed) return;
        const wouldBeBelow = ctx.target.hp < ctx.target.maxHp * 0.40 && ctx.target.hp > 0;
        if (wouldBeBelow) {
          ctx.target.hp += ctx.dmg;
          rt.flags.voidStepUsed = true;
          addLog(`🌑 Void Step — ${ctx.target.name} phased through the strike!`, 'warn');
        }
    } }),
  mkE('void_rare_3', 'Entropy Field', 'void', 'rare',
    "Each round, randomly weaken one enemy spirit (-5% ATK)",
    { roundEnd: (side) => {
        const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
        const alive = foes.filter(c => !c.dead);
        if (!alive.length) return;
        const t = alive[Math.floor(Math.random()*alive.length)];
        t.atkMod = (t.atkMod||1) * 0.95;
        addLog(`🌑 Entropy Field — ${t.name} weakens.`, '');
    } }),
  mkE('void_rare_4', 'Soul Drain', 'void', 'rare',
    'Dealing damage heals you for 5% of damage dealt',
    { onDamageDealt: (side, ctx) => {
        const total = (ctx.card.power || 0) + (ctx.bonusDmg || 0);
        if (total > 0 && ctx.attacker && !ctx.attacker.dead) {
          const heal = Math.max(1, Math.round(total * 0.05));
          ctx.attacker.hp = Math.min(ctx.attacker.maxHp, ctx.attacker.hp + heal);
        }
    } }),

  mkE('void_epic_1', 'Nullification', 'void', 'epic',
    "Once per battle (manual): nullify the next debuff (burn/stun/etc.) enemies try to apply",
    { onApplyBurn: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.nullificationArmed) { ctx.effect.turns = 0; ctx.effect.turnsLeft = 0; rt.flags.nullificationArmed = false; addLog(`🌑 Nullified!`, 'warn'); }
    },
      onApplyStun: (side, ctx) => {
        const rt = emRuntime(side);
        if (rt.flags.nullificationArmed) { ctx.effect.turns = 0; ctx.effect.turnsLeft = 0; rt.flags.nullificationArmed = false; addLog(`🌑 Nullified!`, 'warn'); }
    } },
    {
      buttonLabel: 'NULLIFY',
      activate: (side) => {
        emRuntime(side).flags.nullificationArmed = true;
        addLog(`🌑 Nullification armed — next enemy debuff cancelled.`, 'warn');
    } }),
  mkE('void_epic_2', 'Oblivion Mark', 'void', 'epic',
    'After turn 5, opponent loses 20% of their max HP instantly (once per battle)',
    { turnStart: (side) => {
        const rt = emRuntime(side);
        if (rt.flags.oblivionFired) return;
        if (G.turn >= 5) {
          rt.flags.oblivionFired = true;
          const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
          for (const c of foes) {
            if (!c.dead) {
              const loss = Math.round(c.maxHp * 0.20);
              c.maxHp = Math.max(1, c.maxHp - loss);
              c.hp = Math.min(c.hp, c.maxHp);
            }
          }
          addLog(`🌑 OBLIVION MARK — enemies wither.`, 'crit');
        }
    } }),

  mkE('void_prismatic_1', 'Entropy', 'void', 'prismatic',
    'Each round, remove one effect from a random enemy spirit (their buff or our debuff)',
    { roundEnd: (side) => {
        const foes = (side === 'player' ? G.enemyTeam : G.playerTeam).filter(c=>!c.dead && c.effects.length);
        if (!foes.length) return;
        const t = foes[Math.floor(Math.random()*foes.length)];
        const removedIdx = Math.floor(Math.random()*t.effects.length);
        t.effects.splice(removedIdx, 1);
        addLog(`🌑 Entropy strips an effect from ${t.name}.`, '');
    } }),
  mkE('void_prismatic_2', 'Void Collapse', 'void', 'prismatic',
    'Once per battle (manual): drain 30% of EACH enemy\'s current HP (ignores shields)',
    {}, {
      buttonLabel: 'COLLAPSE',
      activate: (side) => {
        const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
        for (const c of foes) {
          if (!c.dead) {
            const loss = Math.round(c.hp * 0.30);
            c.hp -= loss;
            showFloatDmg(c, loss, '#c87898');
            shakeEl(c);
          }
        }
        addLog(`🌑 VOID COLLAPSE — reality folds inward!`, 'crit');
        renderBattle();
    } }),

  // ═══════════════════════════════════════════════════════════
  // EARTH
  // ═══════════════════════════════════════════════════════════
  mkE('earth_common_1', 'Iron Skin', 'earth', 'common',
    'Take 6 less damage from all attacks (flat)',
    { modifyIncomingDamage: (side, dmg) => Math.max(0, dmg - 6) }),
  mkE('earth_common_2', 'Tremor', 'earth', 'common',
    '10% chance on attack to stun the target for 1 turn',
    { onDamageDealt: (side, ctx) => {
        if (ctx.card.type !== 'damage' && ctx.card.type !== 'drain') return;
        if (ctx.target.dead) return;
        if (Math.random() < 0.10 && !ctx.target.effects.find(e=>e.type==='stun')) {
          ctx.target.effects.push({ type:'stun', turns:1, turnsLeft:1, _src:'emblem' });
          addLog(`🪨 Tremor stuns ${ctx.target.name}!`, 'warn');
        }
    } }),
  mkE('earth_common_3', 'Stone Heart', 'earth', 'common',
    '+25 max HP for all spirits',
    { battleStart: (side, ctx) => { for (const c of ctx.team) { c.maxHp += 25; c.hp += 25; } } }),
  mkE('earth_common_4', 'Dust Shield', 'earth', 'common',
    'Start of battle: each spirit gains a 20-point shield',
    { battleStart: (side, ctx) => { for (const c of ctx.team) c.shield = Math.min(200, (c.shield||0) + 20); } }),

  mkE('earth_rare_1', 'Tectonic Force', 'earth', 'rare',
    'Shield-piercing attacks deal +15 extra damage',
    { onDamageDealt: (side, ctx) => {
        if (ctx.card && ctx.card.pierce) ctx.bonusDmg = (ctx.bonusDmg||0) + 15;
    } }),
  mkE('earth_rare_2', 'Fortify', 'earth', 'rare',
    'Each time you take damage, gain +2 permanent damage reduction (max 20)',
    { onDamageTaken: (side) => {
        const rt = emRuntime(side);
        rt.stats.fortifyArmor = Math.min(20, (rt.stats.fortifyArmor||0) + 2);
    },
      modifyIncomingDamage: (side, dmg) => {
        const armor = emRuntime(side).stats.fortifyArmor || 0;
        return Math.max(0, dmg - armor);
    } }),
  mkE('earth_rare_3', 'Aftershock', 'earth', 'rare',
    'When you use a shield card, deal 10 shockwave damage to a random enemy',
    { onShieldGained: (side) => {
        const foes = (side === 'player' ? G.enemyTeam : G.playerTeam).filter(c=>!c.dead);
        if (!foes.length) return;
        const t = foes[Math.floor(Math.random()*foes.length)];
        applyDamage(t, 10);
        addLog(`🪨 Aftershock hits ${t.name} for 10!`, '');
    } }),
  mkE('earth_rare_4', 'Bedrock', 'earth', 'rare',
    'You cannot be reduced below 10 HP in a single hit (overflow negated)',
    { modifyIncomingDamage: (side, dmg, ctx) => {
        if (!ctx.target) return dmg;
        const wouldLeave = ctx.target.hp - dmg;
        if (wouldLeave < 10 && ctx.target.hp > 10) {
          const allowed = ctx.target.hp - 10;
          addLog(`🪨 Bedrock holds ${ctx.target.name} at 10 HP!`, 'warn');
          return allowed;
        }
        return dmg;
    } }),

  mkE('earth_epic_1', 'Landslide', 'earth', 'epic',
    'Every 4 rounds, deal 30 piercing damage to a random enemy (ignores shields)',
    { roundEnd: (side) => {
        const rt = emRuntime(side);
        rt.counters.landslide = (rt.counters.landslide||0) + 1;
        if (rt.counters.landslide % 4 !== 0) return;
        const foes = (side === 'player' ? G.enemyTeam : G.playerTeam).filter(c=>!c.dead);
        if (!foes.length) return;
        const t = foes[Math.floor(Math.random()*foes.length)];
        applyDamage(t, 30, null, true);
        shakeEl(t);
        addLog(`🪨 LANDSLIDE crushes ${t.name} for 30!`, 'crit');
    } }),
  mkE('earth_epic_2', 'Petrify', 'earth', 'epic',
    'Once per battle (manual): stun all enemies 2 turns + weaken their ATK 20% for the rest of the battle',
    {}, {
      buttonLabel: 'PETRIFY',
      activate: (side) => {
        const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
        for (const c of foes) {
          if (!c.dead) {
            c.effects.push({ type:'stun', turns:2, turnsLeft:2, _src:'emblem' });
            c.atkMod = (c.atkMod||1) * 0.80;
          }
        }
        addLog(`🪨 PETRIFY — enemies frozen and weakened!`, 'crit');
        renderBattle();
    } }),

  mkE('earth_prismatic_1', 'Continental Drift', 'earth', 'prismatic',
    'Every round, all your spirits gain +10 max HP permanently (stacks forever)',
    { roundEnd: (side, ctx) => {
        for (const c of ctx.team) {
          if (!c.dead) { c.maxHp += 10; c.hp += 10; }
        }
    } }),
  mkE('earth_prismatic_2', 'World Breaker', 'earth', 'prismatic',
    'Once per battle (manual): deal damage equal to 40% of each enemy\'s current HP (ignores shields)',
    {}, {
      buttonLabel: 'BREAK',
      activate: (side) => {
        const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
        for (const c of foes) {
          if (!c.dead) {
            const loss = Math.round(c.hp * 0.40);
            c.hp -= loss;
            showFloatDmg(c, loss, '#e8a060');
            shakeEl(c);
          }
        }
        addLog(`🪨 WORLD BREAKER — the earth itself rebels!`, 'crit');
        renderBattle();
    } }),

  // ═══════════════════════════════════════════════════════════
  // ✨ MYTHIC TIER — cross-class, ~1% Mystic Chest drop
  // ═══════════════════════════════════════════════════════════
  mkE('mythic_soul_forge', 'Soul Forge', 'arcane', 'mythic',
    'When an ally dies, ALL remaining allies gain +20 ATK permanently (stacks)',
    { onDeath: (side, ctx) => {
        const team = side === 'player' ? G.playerTeam : G.enemyTeam;
        for (const c of team) {
          if (!c.dead && c !== ctx.victim) c.atk = (c.atk||0) + 20;
        }
        addLog(`✨ SOUL FORGE — survivors empowered (+20 ATK)!`, 'crit');
    } }),
  mkE('mythic_karmas_edge', "Karma's Edge", 'arcane', 'mythic',
    'Deal +30% damage. Take +20% damage. Glass cannon.',
    { onDamageDealt: (side, ctx) => { ctx.bonusDmg = (ctx.bonusDmg||0) + Math.round((ctx.card.power||0) * 0.30); },
      modifyIncomingDamage: (side, dmg) => Math.round(dmg * 1.20) }),
  mkE('mythic_time_pause', 'Time Pause', 'arcane', 'mythic',
    "Once per battle (manual): skip opponent's next 2 turns entirely",
    {}, {
      buttonLabel: 'PAUSE',
      activate: (side) => {
        const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
        for (const c of foes) {
          if (!c.dead) c.effects.push({ type:'stun', turns:2, turnsLeft:2, _src:'mythic', _label:'Time-Paused' });
        }
        addLog(`✨ TIME PAUSE — the opponent freezes for 2 turns!`, 'crit');
        renderBattle();
    } }),
  mkE('mythic_phoenix_cycle', 'Phoenix Cycle', 'arcane', 'mythic',
    'When a spirit dies, it revives once at 25% HP (1 per battle, stacks with Ashphoenix)',
    { battleStart: (side) => { emRuntime(side).flags.phoenixCycleCharges = 1; } }),
  mkE('mythic_quantum_lock', 'Quantum Lock', 'arcane', 'mythic',
    "Once per battle (manual): extend all current enemy debuffs to last 3 more turns",
    {}, {
      buttonLabel: 'LOCK',
      activate: (side) => {
        const foes = side === 'player' ? G.enemyTeam : G.playerTeam;
        for (const c of foes) {
          if (!c.dead) {
            for (const ef of c.effects) {
              ef.turns = Math.max(ef.turns, 3);
              ef.turnsLeft = Math.max(ef.turnsLeft, 3);
            }
          }
        }
        addLog(`✨ QUANTUM LOCK — enemy effects frozen in time!`, 'crit');
        renderBattle();
    } }),
  mkE('mythic_resonance', 'Resonance', 'arcane', 'mythic',
    'Every card you play heals all your spirits for 3 HP',
    { onCardPlayed: (side) => {
        const team = side === 'player' ? G.playerTeam : G.enemyTeam;
        for (const c of team) if (!c.dead) c.hp = Math.min(c.maxHp, c.hp + 3);
    } }),
];

function emblemById(id) { return EMBLEMS.find(e => e.id === id); }
function emblemsByClass(cls) { return EMBLEMS.filter(e => e.class === cls); }
function emblemsByRarity(r)  { return EMBLEMS.filter(e => e.rarity === r); }

// Dispatch a hook on the side's equipped emblem. modifyIncomingDamage returns
// the modified dmg through ctx.dmg; other hooks are fire-and-forget.
function applyEmblemHook(trigger, side, ctx) {
  const emblemId = side === 'player' ? (G && G.playerEmblem) : (G && G.enemyEmblem);
  if (!emblemId) return ctx && ctx.dmg;
  const emb = emblemById(emblemId);
  if (!emb || !emb.hooks || !emb.hooks[trigger]) return ctx && ctx.dmg;
  try {
    const r = emb.hooks[trigger](side, ctx);
    if (typeof r === 'number') return r;
  } catch (e) { console.warn('emblem hook error', trigger, emb.id, e); }
  return ctx && ctx.dmg;
}

// ═══════════════════════════════════════════════════
// LOOT CASES — drop logic, pity, persistence
// ═══════════════════════════════════════════════════
const LOOT_CASES = [
  { id:'sleeve',  name:'Magic Sleeve',     emoji:'🧤', unlockLevel:5,  cost:100,  items:1, mix:'cards-only',  pityType:'rare',  pityThreshold:10,
    desc:'1 card from a random spirit you own.' },
  { id:'emperor', name:"Emperor's Wish",   emoji:'👑', unlockLevel:11, cost:275,  items:3, mix:'cards-only',  pityType:'epic',  pityThreshold:7,
    desc:'3 cards from spirits you own.' },
  { id:'mystic',  name:'Mystic Chest',     emoji:'🌌', unlockLevel:26, cost:1000, items:5, mix:'mixed',       pityType:'spirit',pityThreshold:5,
    desc:'5 items: 64% card · 25% emblem · 10% spirit · 1% MYTHIC.' },
];
function caseById(id) { return LOOT_CASES.find(c => c.id === id); }

const DUST_CONVERSION = 50;

function rollCaseContents(caseId) {
  const c = caseById(caseId);
  if (!c) return [];
  const results = [];
  const pityKey = 'pity_' + c.id;
  for (let i = 0; i < c.items; i++) {
    const item = rollOneItem(c, i === c.items - 1);
    results.push(item);
    if (c.pityType === 'spirit') {
      if (item.kind === 'spirit') PLAYER[pityKey] = 0;
      else PLAYER[pityKey] = (PLAYER[pityKey]||0) + (1 / c.items);
    } else {
      PLAYER[pityKey] = (PLAYER[pityKey]||0) + 1;
    }
  }
  if (PLAYER[pityKey] != null) PLAYER[pityKey] = Math.floor(PLAYER[pityKey]);
  return results;
}

function rollOneItem(c) {
  if (c.mix === 'cards-only') return rollCardDrop();
  const pity = PLAYER['pity_'+c.id] || 0;
  const forceSpirit = (c.pityType === 'spirit' && pity >= c.pityThreshold);
  if (forceSpirit) { const sp = rollSpiritDrop(); if (sp) return sp; }
  const r = Math.random();
  if (r < 0.01) { const m = rollEmblemOfRarity('mythic'); if (m) return m; }
  if (r < 0.11) { const sp = rollSpiritDrop(); if (sp) return sp; }
  if (r < 0.36) { const em = rollEmblemDrop();  if (em) return em; }
  return rollCardDrop();
}

function rollCardDrop() {
  const owned = (PLAYER && PLAYER.unlocked) || [];
  if (!owned.length) return { kind:'coins', amount: DUST_CONVERSION, reason:'no-spirits' };
  const spiritsWithSlots = [];
  for (const sid of owned) {
    const spirit = SPIRITS.find(s => s.id === sid);
    if (!spirit) continue;
    const entry = PLAYER.spirits[sid];
    if (!entry) continue;
    const ownedCards = new Set(entry.owned || []);
    const unowned = spirit.pool.filter(c => !ownedCards.has(c.name));
    if (unowned.length > 0) spiritsWithSlots.push({ spirit, unowned });
  }
  if (!spiritsWithSlots.length) return { kind:'coins', amount: DUST_CONVERSION, reason:'no-card-slots' };
  const pick = spiritsWithSlots[Math.floor(Math.random()*spiritsWithSlots.length)];
  const card = pick.unowned[Math.floor(Math.random()*pick.unowned.length)];
  return { kind:'card', spiritId: pick.spirit.id, cardName: card.name, spiritName: pick.spirit.name };
}

function rollSpiritDrop() {
  const owned = new Set((PLAYER && PLAYER.unlocked) || []);
  const unowned = SPIRITS.filter(s => !owned.has(s.id));
  if (!unowned.length) return null;
  const s = unowned[Math.floor(Math.random()*unowned.length)];
  return { kind:'spirit', spiritId: s.id, spiritName: s.name };
}

function rollEmblemDrop() {
  // Excludes Mythic — Mythic is rolled at the case level (1% pre-check in rollOneItem)
  const r = Math.random() * 100;
  let rarity;
  if      (r < 55) rarity = 'common';
  else if (r < 85) rarity = 'rare';
  else if (r < 97) rarity = 'epic';
  else             rarity = 'prismatic';
  return rollEmblemOfRarity(rarity);
}

function rollEmblemOfRarity(rarity) {
  const owned = new Set((PLAYER && PLAYER.emblems) || []);
  const pool = EMBLEMS.filter(e => e.rarity === rarity && !owned.has(e.id));
  if (!pool.length) {
    // Cascade down: try lower rarities so we never give a duplicate
    const order = ['mythic','prismatic','epic','rare','common'];
    for (const r of order) {
      const p = EMBLEMS.filter(e => e.rarity === r && !owned.has(e.id));
      if (p.length) {
        const em = p[Math.floor(Math.random()*p.length)];
        return { kind:'emblem', emblemId: em.id, name: em.name, rarity: em.rarity, cls: em.class };
      }
    }
    return null;
  }
  const em = pool[Math.floor(Math.random()*pool.length)];
  return { kind:'emblem', emblemId: em.id, name: em.name, rarity: em.rarity, cls: em.class };
}

async function awardDrop(drop) {
  if (drop.kind === 'coins') {
    PLAYER.gold = (PLAYER.gold||0) + drop.amount;
    savePlayer();
    return `+${drop.amount} 🪙`;
  }
  if (drop.kind === 'card') {
    const entry = PLAYER.spirits[drop.spiritId];
    if (entry && !entry.owned.includes(drop.cardName)) {
      entry.owned.push(drop.cardName);
      savePlayer();
      persistSpiritCards(drop.spiritId);
    }
    return `${drop.spiritName}: ${drop.cardName}`;
  }
  if (drop.kind === 'spirit') {
    if (!PLAYER.unlocked.includes(drop.spiritId)) {
      unlockSpirit(PLAYER, drop.spiritId);
      savePlayer();
      persistSpiritUnlock(drop.spiritId);
      persistSpiritCards(drop.spiritId);
    }
    return `🌟 Spirit Unlocked: ${drop.spiritName}!`;
  }
  if (drop.kind === 'emblem') {
    PLAYER.emblems = PLAYER.emblems || [];
    if (!PLAYER.emblems.includes(drop.emblemId)) {
      PLAYER.emblems.push(drop.emblemId);
      persistEmblemGain(drop.emblemId);
    }
    return `${EMBLEM_RARITY_META[drop.rarity].label} Emblem: ${drop.name}`;
  }
  return '?';
}

async function persistEmblemGain(emblemId) {
  if (!AUTH_USER || !SUPABASE_CONFIGURED) return;
  try { await db.from('player_emblems').insert({ player_id: AUTH_USER.id, emblem_id: emblemId }); }
  catch (e) { console.warn('persistEmblemGain', e); }
}

async function persistActiveEmblem(emblemId) {
  if (!AUTH_USER || !SUPABASE_CONFIGURED) return;
  try { await db.from('players').update({ active_emblem: emblemId }).eq('id', AUTH_USER.id); }
  catch (e) { console.warn('persistActiveEmblem', e); }
}

async function persistPity() {
  if (!AUTH_USER || !SUPABASE_CONFIGURED || !PLAYER) return;
  try {
    await db.from('players').update({
      pity_sleeve:  PLAYER.pity_sleeve  || 0,
      pity_emperor: PLAYER.pity_emperor || 0,
      pity_mystic:  PLAYER.pity_mystic  || 0
    }).eq('id', AUTH_USER.id);
  } catch (e) { console.warn('persistPity', e); }
}
