export interface FeatureSummary {
  originRef: string;
  /**
   * How far along, in a few words — the line a reader repeats when somebody asks how
   * the Feature is going. Null on every row written before the field existed; the
   * card draws nothing for it, and the next rewrite fills it in.
   * → docs/spec/17-cockpit.md#how-far-along
   */
  headline: string | null;
  standing: string;
  usable: string | null;
  blocked: string | null;
  remaining: string | null;
  standingKey: string;
  /** The child fact lines the summary was written against; null on a row from before they were kept. */
  standingLines: string[] | null;
  /** How many times in a row the same account was refiled. → docs/spec/05-dispatcher.md */
  repeats: number;
  /** The standing keys that identical account was refiled at. */
  repeatKeys: string[];
  agentId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureSequenceEdge {
  issue: number;
  dependsOn: number;
  source: 'link' | 'inferred' | 'operator';
  reason: string | null;
}

export interface FeatureSequence {
  originRef: string;
  status: 'proposed' | 'accepted' | 'declined';
  reason: string;
  unsure: string | null;
  standingKey: string;
  edges: FeatureSequenceEdge[];
  members: number[] | null;
  answeredBy: string | null;
  answeredAt: string | null;
  agentId: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}
