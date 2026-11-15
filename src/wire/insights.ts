import type { AllowanceInsights } from '../insights/allowanceInsights.js';
import type { ApiErrorInsights } from '../insights/apiErrorInsights.js';
import type { McpInsights } from '../insights/mcpInsights.js';
import type { OperatorInsights } from '../insights/operatorInsights.js';
import type { ReliabilityInsights } from '../insights/reliabilityInsights.js';
import type { RemedyInsights } from '../insights/remedyInsights.js';
import type { ReviewLabelInsights } from '../insights/reviewLabelInsights.js';
import type { SpendInsights } from '../insights/spendInsights.js';
import type { SpendTrend } from '../insights/spendTrend.js';
import type { SurfaceReachInsights } from '../insights/surfaceReachInsights.js';
import type { ThroughputInsights } from '../insights/throughputInsights.js';
import type { PoolRollup, PoolTrends } from '../pool/aggregate.js';
import type { PoolStatus } from '../pool/poolDesk.js';
import type {
  AssessedBotPr,
  BotPrRiskStanding,
  BotPrsReading,
  PoolFleetReading,
  Retrospective,
  ScratchEntry,
} from '../types.js';

export interface RetrospectivePayload {
  retrospective: Retrospective | null;
}

export interface ScratchpadPayload {
  padRef: string;
  entries: ScratchEntry[];
}

export interface SpendPayload {
  insights: SpendInsights;
}

export interface AllowancePayload {
  allowance: AllowanceInsights;
  refUrls: Record<string, string>;
}

export interface SpendTrendPayload {
  trend: SpendTrend;
}

export interface ApiErrorsPayload {
  insights: ApiErrorInsights;
}

export interface McpUsagePayload {
  insights: McpInsights;
}

export interface UsagePayload {
  insights: OperatorInsights;
  reach: SurfaceReachInsights;
}

export interface ReliabilityPayload {
  insights: ReliabilityInsights;
  remedies: RemedyInsights;
  reviewLabels: ReviewLabelInsights;
}

export interface ThroughputPayload {
  insights: ThroughputInsights;
}

export interface BotPrsPayload extends BotPrsReading {
  pullRequests: AssessedBotPr[];
  risk: BotPrRiskStanding;
}

export interface PoolStatePayload {
  status: PoolStatus | null;
  fleets: PoolFleetReading[];
}

export interface PoolInsightsPayload {
  rollup: PoolRollup;
  trends: PoolTrends;
  projects: string[];
  fleets: PoolFleetReading[];
}
