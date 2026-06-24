import { MCCFRSolver, SolverConfig, DEFAULT_SOLVER_CONFIG } from '../core/cfr/cfr-solver';
import { CardId, SolverResult } from '../types/poker';

// ============================================================
// Web Worker for CFR Solver
// Runs MCCFR iterations off the main thread
// ============================================================

let solver: MCCFRSolver | null = null;

interface SolveRequest {
  type: 'solve';
  id: string;
  heroCards: [CardId, CardId];
  board: CardId[];
  pot: number;
  heroStack: number;
  villainStack: number;
  heroPosition: number;
  actionHistory: string;
  config?: Partial<SolverConfig>;
}

interface ConfigRequest {
  type: 'config';
  config: Partial<SolverConfig>;
}

type WorkerMessage = SolveRequest | ConfigRequest;

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case 'config': {
      const config = { ...DEFAULT_SOLVER_CONFIG, ...msg.config };
      solver = new MCCFRSolver(config);
      (self as any).postMessage({ type: 'config_done' });
      break;
    }

    case 'solve': {
      if (!solver) {
        solver = new MCCFRSolver(
          msg.config ? { ...DEFAULT_SOLVER_CONFIG, ...msg.config } : DEFAULT_SOLVER_CONFIG,
        );
      }

      try {
        const result: SolverResult = solver.solve(
          msg.heroCards,
          msg.board,
          msg.pot,
          msg.heroStack,
          msg.villainStack,
          msg.heroPosition,
          msg.actionHistory,
        );

        (self as any).postMessage({
          type: 'solve_result',
          id: msg.id,
          result,
        });
      } catch (err: any) {
        (self as any).postMessage({
          type: 'solve_error',
          id: msg.id,
          error: err.message || 'Solver failed',
        });
      }
      break;
    }
  }
};

// Signal ready
(self as any).postMessage({ type: 'ready' });
