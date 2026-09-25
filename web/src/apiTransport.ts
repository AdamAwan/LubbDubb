export class UnauthorizedError extends Error {
  constructor(readonly status: number) {
    super(status === 403 ? 'Request refused by the cockpit' : 'Cockpit token missing or invalid');
    this.name = 'UnauthorizedError';
  }
}

const TOKEN_KEY = 'lubbdubb.cockpitToken';

function readToken(): string {
  try {
    const fromHash = /[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
    if (fromHash) {
      localStorage.setItem(TOKEN_KEY, fromHash);
      history.replaceState(null, '', location.pathname + location.search);
      return fromHash;
    }
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return typeof location === 'undefined' ? '' : (/[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1] ?? '');
  }
}

export const token = readToken();

export async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError(res.status);
  return res;
}

export async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await refusalText(res)) ?? `${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function refusalText(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown }).error;
    return typeof error === 'string' && error ? error : null;
  } catch {
    return null;
  }
}

export function post<T>(url: string, body?: unknown): Promise<T> {
  return authFetch(url, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }).then((r) => json<T>(r));
}

export function put<T>(url: string, body: unknown): Promise<T> {
  return authFetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));
}

export function del<T>(url: string): Promise<T> {
  return authFetch(url, { method: 'DELETE' }).then((r) => json<T>(r));
}
