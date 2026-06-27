import { GameState, PlayerProfile, StrategyDistribution, BotDecision } from '../types/poker';
import { PlayerProfiler } from '../core/exploit/profiler';
import { GTOAdvice } from '../core/ranges/gto-advisor';

const OVERLAY_ID = 'gto-bot-overlay';
const PANEL_ID = 'gto-bot-panel';
const TOGGLE_ID = 'gto-bot-toggle';
// Bump on every release so the running build is identifiable on the table.
const VERSION = 'v0.1.49';

interface SessionStats {
  hands: number;
  profit: number;
  vpip: number;
  vpipOpp: number;
  startTime: number;
  bigBlind: number; // latest big blind, for bb/100 win-rate
}

export class HUDOverlay {
  private container: HTMLElement | null = null;
  // Single consolidated panel (GTO ranges + bot action + session), anchored
  // bottom-left so it never sits over PokerNow's action buttons (bottom-right).
  private panel: HTMLElement | null = null;
  private toggleBtn: HTMLElement | null = null;
  private visible: boolean = true;
  private sessionStats: SessionStats = { hands: 0, profit: 0, vpip: 0, vpipOpp: 0, startTime: Date.now(), bigBlind: 0 };
  private lastDecision: BotDecision | null = null;
  private lastEquity: number = 0;
  private lastAdvice: GTOAdvice | null = null;
  private execStatus: string = '';

  initialize(): void {
    // Idempotency guard: remove any overlay elements from a previous init or a
    // double-injected content script (and legacy IDs from older builds) so we
    // can never end up with two overlays on the page.
    const STALE_IDS = [OVERLAY_ID, PANEL_ID, TOGGLE_ID, 'gto-bot-decision', 'gto-bot-gto-panel'];
    for (const id of STALE_IDS) {
      document.querySelectorAll(`#${id}`).forEach(el => el.remove());
    }

    this.container = document.createElement('div');
    this.container.id = OVERLAY_ID;
    this.container.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none; z-index: 99999;
    `;
    document.body.appendChild(this.container);

    this.panel = document.createElement('div');
    this.panel.id = PANEL_ID;
    this.panel.style.cssText = `
      position: fixed; bottom: 16px; left: 16px;
      background: rgba(12, 12, 20, 0.94);
      color: #e0e0e0; padding: 0;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px; width: 270px;
      pointer-events: auto; z-index: 100001;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      animation: gto-slide-in 0.3s ease;
    `;
    document.body.appendChild(this.panel);

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.id = TOGGLE_ID;
    this.toggleBtn.textContent = 'G';
    this.toggleBtn.title = 'Toggle GTO HUD (Alt+G)';
    this.toggleBtn.addEventListener('click', () => this.toggle());
    document.body.appendChild(this.toggleBtn);

    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.toLowerCase() === 'g') this.toggle();
    });

    this.clearDecision();
    console.log('[GTO Bot] HUD overlay initialized');
  }

  updateSessionStats(stats: Partial<SessionStats>): void {
    Object.assign(this.sessionStats, stats);
    this.render();
  }

  updatePlayerStats(
    state: GameState,
    profiles: Map<string, PlayerProfile>,
    displayStats: Map<string, { vpip: number; pfr: number; threeBet: number; af: number; hands: number }>,
  ): void {
    if (!this.container || !this.visible) return;

    this.container.querySelectorAll('.gto-player-stats').forEach(el => el.remove());

    const playerElements = document.querySelectorAll('.table-player');

    playerElements.forEach((playerEl) => {
      const nameEl = playerEl.querySelector('.table-player-name');
      const name = nameEl?.textContent?.trim() || '';
      if (!name) return;

      const profile = profiles.get(name);
      const stats = displayStats.get(name);
      if (!stats || stats.hands < 3) return;

      const rect = playerEl.getBoundingClientRect();
      const statsBox = document.createElement('div');
      statsBox.className = 'gto-player-stats';

      const typeColor = profile ? PlayerProfiler.typeColor(profile.type) : '#95a5a6';
      const typeLabel = profile ? PlayerProfiler.typeLabel(profile.type) : '???';

      const vpipColor = stats.vpip > 35 ? '#e74c3c' : stats.vpip < 18 ? '#4a90d9' : '#2ecc71';
      const pfrColor = stats.pfr > 25 ? '#e74c3c' : stats.pfr < 12 ? '#4a90d9' : '#2ecc71';
      const afColor = stats.af > 3 ? '#f39c12' : stats.af < 1 ? '#4a90d9' : '#2ecc71';

      statsBox.style.cssText = `
        position: fixed;
        left: ${rect.left + rect.width / 2 - 68}px;
        top: ${rect.top - 52}px;
        background: rgba(10, 10, 18, 0.92);
        color: #e0e0e0; padding: 5px 8px;
        border-radius: 6px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 11px; pointer-events: auto;
        white-space: nowrap;
        border: 1px solid ${typeColor}44;
        border-left: 3px solid ${typeColor};
        z-index: 99999;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      `;

      statsBox.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px; margin-bottom:3px;">
          <span class="type-badge" style="background:${typeColor}; color:#000;">${typeLabel}</span>
          <span style="color:#666; font-size:10px;">${stats.hands}h</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">VP</span><span class="stat-val" style="color:${vpipColor}">${stats.vpip.toFixed(0)}</span>
          <span class="stat-label">PF</span><span class="stat-val" style="color:${pfrColor}">${stats.pfr.toFixed(0)}</span>
          <span class="stat-label">3B</span><span class="stat-val">${stats.threeBet.toFixed(0)}</span>
          <span class="stat-label">AF</span><span class="stat-val" style="color:${afColor}">${stats.af.toFixed(1)}</span>
        </div>
      `;

      this.container!.appendChild(statsBox);
    });
  }

  showDecision(decision: BotDecision, equity: number): void {
    this.lastDecision = decision;
    this.lastEquity = equity;
    this.render();
  }

  clearDecision(): void {
    this.lastDecision = null;
    this.render();
  }

  showGTOAdvice(advice: GTOAdvice): void {
    this.lastAdvice = advice;
    this.render();
  }

  clearGTOAdvice(): void {
    this.lastAdvice = null;
    this.render();
  }

  /** Show the executor's last step (e.g. "try bet $65", "bet via preset",
   *  "raise form not found", "safe fallback: check") so stalls are visible. */
  showExecStatus(status: string): void {
    if (!status || status === this.execStatus) return;
    this.execStatus = status;
    this.render();
  }

  /**
   * Render the single consolidated panel: GTO ranges on top, the bot's chosen
   * action + equity below, then the session strip. One panel, one source of
   * truth, so the displayed mix and the action never contradict each other.
   */
  private render(): void {
    if (!this.panel || !this.visible) return;

    const gtoHtml = this.lastAdvice ? this.renderGTOSection(this.lastAdvice) : '';
    const actionHtml = this.lastDecision
      ? this.renderActionSection(this.lastDecision, this.lastEquity)
      : `<div class="waiting" style="padding:10px 14px;"><div class="pulse"></div>Waiting for your turn...</div>`;
    const sessionHtml = this.renderSessionStrip();
    const execHtml = this.execStatus
      ? `<div style="font-size:10px; color:#8aa; padding:2px 8px; font-family:monospace;">exec: ${this.execStatus}</div>`
      : '';
    const versionHtml = `<div style="font-size:9px; color:#556; text-align:right; padding:3px 8px 4px; letter-spacing:0.5px;">${VERSION} · approximation, not perfect GTO</div>`;

    this.panel.innerHTML = `${gtoHtml}${actionHtml}${sessionHtml}${execHtml}${versionHtml}`;
  }

  private renderGTOSection(advice: GTOAdvice): string {
    const GTO_COLORS: Record<string, string> = {
      'Raise': '#2ecc71', '3-Bet': '#2ecc71', '4-Bet': '#2ecc71',
      'Call': '#3498db', 'Fold': '#e74c3c', 'All-In': '#f39c12',
    };
    const primary = advice.actions[0];
    const headerColor = primary ? (GTO_COLORS[primary.action] || '#2ecc71') : '#95a5a6';

    const barsHtml = advice.actions.map(a => {
      const color = GTO_COLORS[a.action] || '#95a5a6';
      return `
        <div style="display:flex; align-items:center; gap:8px; margin:4px 0;">
          <div style="width:48px; font-size:12px; font-weight:600; color:${color}; text-align:right;">${a.action}</div>
          <div style="flex:1; height:20px; background:rgba(255,255,255,0.06); border-radius:4px; overflow:hidden;">
            <div style="height:100%; width:${a.frequency}%; background:${color}; border-radius:4px; transition:width 0.4s ease;"></div>
          </div>
          <div style="width:38px; font-size:13px; font-weight:700; color:${color}; text-align:right;">${Math.round(a.frequency)}%</div>
        </div>`;
    }).join('');

    const rangeTag = advice.inRange
      ? `<span style="background:${headerColor}22; color:${headerColor}; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600;">IN RANGE</span>`
      : `<span style="background:#e74c3c22; color:#e74c3c; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600;">OUT OF RANGE</span>`;

    return `
      <div style="background:linear-gradient(135deg, ${headerColor}20, transparent); padding:10px 14px 8px; border-bottom:1px solid rgba(255,255,255,0.06);">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
          <span style="font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#888; font-weight:600;">GTO Ranges</span>
          ${rangeTag}
        </div>
        <div style="display:flex; align-items:baseline; gap:8px;">
          <span style="font-size:22px; font-weight:800; color:#fff; letter-spacing:-0.5px;">${advice.hand}</span>
          <span style="font-size:11px; color:#aaa;">${advice.scenario}</span>
        </div>
      </div>
      <div style="padding:8px 14px ${this.lastDecision ? '10px' : '12px'};">
        ${barsHtml || '<div style="color:#666; font-size:12px; text-align:center; padding:8px 0;">No GTO data for this spot</div>'}
      </div>`;
  }

  private renderActionSection(decision: BotDecision, equity: number): string {
    const actionColor = this.getActionColor(decision.action);
    const amountStr = decision.amount ? ` $${decision.amount}` : '';
    const label = decision.action.toUpperCase();
    return `
      <div style="padding:10px 14px; border-top:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.02);">
        <div style="display:flex; align-items:baseline; gap:6px;">
          <span style="font-size:10px; text-transform:uppercase; letter-spacing:1px; color:#888; font-weight:600;">Bot plays</span>
          <span style="margin-left:auto; font-size:11px; color:#666;">${(decision.confidence * 100).toFixed(0)}% conf</span>
        </div>
        <div style="display:flex; align-items:baseline; gap:4px; margin:2px 0 4px;">
          <span style="font-size:18px; font-weight:800; color:${actionColor}">${label}</span>
          <span style="font-size:18px; font-weight:800; color:${actionColor}">${amountStr}</span>
        </div>
        <div style="font-size:11px; color:#999; margin-bottom:6px;">${decision.reasoning}</div>
        ${this.renderEquityBar(equity, decision)}
      </div>`;
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.container) this.container.style.display = this.visible ? 'block' : 'none';
    if (this.panel) this.panel.style.display = this.visible ? 'block' : 'none';
    if (this.toggleBtn) {
      this.toggleBtn.style.opacity = this.visible ? '1' : '0.4';
    }
  }

  destroy(): void {
    this.container?.remove();
    this.panel?.remove();
    this.toggleBtn?.remove();
    this.container = null;
    this.panel = null;
    this.toggleBtn = null;
  }

  getSessionStats(): SessionStats {
    return { ...this.sessionStats };
  }

  private renderEquityBar(equity: number, decision: BotDecision): string {
    const eqPct = equity * 100;
    const eqColor = equity > 0.6 ? '#2ecc71' : equity > 0.4 ? '#f39c12' : '#e74c3c';

    return `
      <div class="eq-bar-container">
        <div class="eq-bar-labels">
          <span>Equity: <b style="color:${eqColor}">${eqPct.toFixed(1)}%</b></span>
          <span>${equity > 0.5 ? 'Ahead' : 'Behind'}</span>
        </div>
        <div class="eq-bar">
          <div class="eq-fill" style="width:${eqPct}%; background: linear-gradient(90deg, ${eqColor}, ${eqColor}88);"></div>
        </div>
      </div>
    `;
  }

  private renderStrategyBar(strat: StrategyDistribution): string {
    const totalBet = strat.bets.reduce((sum, b) => sum + b.probability, 0);
    const segments: { label: string; pct: number; color: string }[] = [];

    if (strat.fold > 0.01) segments.push({ label: 'Fold', pct: strat.fold * 100, color: '#e74c3c' });
    if (strat.check > 0.01) segments.push({ label: 'Check', pct: strat.check * 100, color: '#95a5a6' });
    if (strat.call > 0.01) segments.push({ label: 'Call', pct: strat.call * 100, color: '#3498db' });
    if (totalBet > 0.01) segments.push({ label: 'Raise', pct: totalBet * 100, color: '#2ecc71' });

    if (segments.length === 0) return '';

    const segHtml = segments
      .map(s => `<div class="strat-seg" style="flex-basis:${s.pct}%; background:${s.color};">${s.pct >= 15 ? Math.round(s.pct) + '%' : ''}</div>`)
      .join('');

    const legendHtml = segments
      .map(s => `<span><span class="leg-dot" style="background:${s.color}"></span>${s.label} ${Math.round(s.pct)}%</span>`)
      .join('');

    return `
      <div class="strat-row">${segHtml}</div>
      <div class="strat-legend">${legendHtml}</div>
    `;
  }

  private renderSessionStrip(): string {
    const s = this.sessionStats;
    if (s.hands === 0 && s.profit === 0) return '';

    const profitColor = s.profit >= 0 ? '#2ecc71' : '#e74c3c';
    const profitStr = (s.profit >= 0 ? '+' : '') + s.profit.toFixed(2);
    const elapsed = Math.max(1, (Date.now() - s.startTime) / 60000);
    const timeStr = elapsed >= 60
      ? `${Math.floor(elapsed / 60)}h ${Math.round(elapsed % 60)}m`
      : `${Math.round(elapsed)}m`;
    // bb/100: the standard poker win-rate. This is the BOT's rate (the seat the
    // extension plays); heads-up, your rate is the mirror image, so bot > 0 means
    // it's beating you.
    const bb100 = (s.bigBlind > 0 && s.hands > 0)
      ? (s.profit / s.bigBlind) / s.hands * 100
      : 0;
    const bb100Color = bb100 >= 0 ? '#2ecc71' : '#e74c3c';
    const bb100Str = (bb100 >= 0 ? '+' : '') + bb100.toFixed(1);

    return `
      <div class="session-strip">
        <div class="ss-item">
          <span class="ss-val">${s.hands}</span>
          <span class="ss-label">Hands</span>
        </div>
        <div class="ss-item">
          <span class="ss-val" style="color:${profitColor}">${profitStr}</span>
          <span class="ss-label">Profit</span>
        </div>
        <div class="ss-item">
          <span class="ss-val" style="color:${bb100Color}">${bb100Str}</span>
          <span class="ss-label">bb/100</span>
        </div>
        <div class="ss-item">
          <span class="ss-val">${timeStr}</span>
          <span class="ss-label">Time</span>
        </div>
      </div>
    `;
  }

  private getActionColor(action: string): string {
    switch (action) {
      case 'fold': return '#e74c3c';
      case 'check': return '#95a5a6';
      case 'call': return '#3498db';
      case 'bet': case 'raise': return '#2ecc71';
      case 'allin': return '#f39c12';
      default: return '#e0e0e0';
    }
  }
}
