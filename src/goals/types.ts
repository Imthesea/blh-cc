/** goals 共享数据类型。 */
export class GoalError extends Error {}

export interface GoalState {
  condition: string;
  iterations: number;
  setAt: number; // 秒
  tokensAtStart: number;
  lastReason?: string;
}

export interface GoalEvaluation {
  ok: boolean;
  reason: string;
  impossible: boolean;
}

export type StopAction =
  | "allow"
  | "defer"
  | "achieved"
  | "failed"
  | "limit"
  | "error"
  | "block";

export interface StopDecision {
  action: StopAction;
  reason: string;
}
