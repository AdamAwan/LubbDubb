import type { AppErrorDetail, AppErrorEnvironmentView, AppErrorGroupView, AppErrorsPayload } from '../types.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

const DAY_MS = 86_400_000;

type Group = Omit<AppErrorGroupView, 'environment' | 'daily' | 'returnedAt' | 'link' | 'tracker'> & {
  series: number[];
  link?: AppErrorGroupView['link'];
};

function group(environment: string, now: number, g: Group): AppErrorGroupView {
  const { series, link, ...rest } = g;
  const daily = series.map((count, i) => ({
    day: new Date(now - (series.length - 1 - i) * DAY_MS).toISOString().slice(0, 10),
    count,
  }));
  return {
    ...rest,
    environment,
    daily,
    returnedAt: null,
    link: link ?? null,
    tracker: null,
  };
}

export function demoAppErrors(now: number): AppErrorsPayload {
  const ago = (hours: number): string => new Date(now - hours * 3_600_000).toISOString();
  const staging: AppErrorEnvironmentView = {
    environment: 'staging',
    band: 'staging',
    reading: {
      environment: 'staging',
      status: 'ok',
      detail: null,
      readAt: ago(0.2),
      okAt: ago(0.2),
    },
    head: { environment: 'staging', sha: '9f3c2a1', previousSha: '41be07d', observedAt: ago(0.2), changedAt: ago(20) },
    groups: stagingGroups(now, ago),
  };
  const prod: AppErrorEnvironmentView = {
    environment: 'prod',
    band: 'prod',
    reading: {
      environment: 'prod',
      status: 'unknown',
      detail: 'the errors command exited 1: az: the access token has expired',
      readAt: ago(0.3),
      okAt: ago(30),
    },
    head: { environment: 'prod', sha: '41be07d', previousSha: null, observedAt: ago(0.3), changedAt: null },
    groups: [],
  };
  return {
    project: 'bookshop',
    environments: [staging, prod],
    bands: [staging, prod].map((env) => ({
      band: env.environment,
      declared: false,
      environments: [env.environment],
      status: env.reading?.status ?? null,
      groups: env.groups.map((g) => ({
        key: g.key,
        fingerprint: g.fingerprint,
        title: g.title,
        state: g.state,
        environments: [env.environment],
        count: g.count,
        lastSeen: g.lastSeen,
      })),
    })),
  };
}

function stagingGroups(now: number, ago: (hours: number) => string): AppErrorGroupView[] {
  const quiet = [3, 2, 4, 3, 2, 3, 4, 2, 3, 3, 2, 4, 3, 2];
  return [
    group('staging', now, {
      fingerprint: 'refund-null-ledger',
      key: 'err:bookshop:3fa9c1d0',
      title: 'TypeError: Cannot read properties of null (reading "ledgerId") in issueRefund',
      operation: 'POST /api/refunds',
      version: '2026.10.20.1',
      frames: ['apps/api/src/features/refunds/issue.ts:88'],
      hasDetail: true,
      url: 'https://portal.azure.com/',
      firstSeen: ago(18),
      lastSeen: ago(1),
      state: 'new',
      count: 37,
      ignored: false,
      series: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12, 25],
      link: {
        goalRef: 'issue:395',
        how: ['frame-match'],
        why: 'issue.ts changed only by #395, of 3 goals in the deploy window 41be07d..9f3c2a1.',
        candidates: 3,
        tied: [],
      },
    }),
    group('staging', now, {
      fingerprint: 'checkout-timeout',
      key: 'err:bookshop:a1c0e9b2',
      title: 'TimeoutError: payment provider did not answer within 10s',
      operation: 'POST /api/checkout/pay',
      version: null,
      frames: ['apps/api/src/checkout/pay.ts:142'],
      hasDetail: true,
      url: 'https://portal.azure.com/',
      firstSeen: ago(300),
      lastSeen: ago(2),
      state: 'spiking',
      count: 96,
      ignored: false,
      series: [2, 3, 2, 1, 2, 3, 2, 2, 3, 2, 2, 18, 26, 28],
      link: {
        goalRef: null,
        how: [],
        why: 'No link: pay.ts changed as much by #398 as by #364, of 3 goals in the deploy window 41be07d..9f3c2a1, and nothing else separates them.',
        candidates: 3,
        tied: ['issue:398', 'issue:364'],
      },
    }),
    group('staging', now, {
      fingerprint: 'isbn-lookup-404',
      key: 'err:bookshop:0d7e44f1',
      title: 'NotFoundError: ISBN lookup returned 404',
      operation: 'GET /api/books/:isbn',
      version: null,
      frames: [],
      hasDetail: false,
      url: null,
      firstSeen: ago(320),
      lastSeen: ago(3),
      state: 'steady',
      count: quiet.reduce((n, c) => n + c, 0),
      ignored: false,
      series: quiet,
    }),
  ];
}

const DETAILS: Record<string, AppErrorDetail> = {
  'refund-null-ledger': {
    message: 'Cannot read properties of null (reading "ledgerId")',
    stack: [
      'TypeError: Cannot read properties of null (reading "ledgerId")',
      '    at issueRefund (apps/api/src/features/refunds/issue.ts:88:31)',
      '    at RefundsController.create (apps/api/src/features/refunds/controller.ts:41:12)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  },
  'checkout-timeout': { message: 'payment provider did not answer within 10s', stack: null },
};

export function demoAppErrorDetail(fingerprint: string): AppErrorDetail | null {
  return DETAILS[fingerprint] ?? null;
}
