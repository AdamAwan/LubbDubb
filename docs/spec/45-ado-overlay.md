# 45 — The Azure DevOps overlay

**Experiment.** Built: `GET /api/prs/agents`, the hidden bridge page `web/public/ado-bridge.html`, and
the bookmarklet below. It is an experiment in showing LubbDubb's fleet inside the Azure DevOps UI
itself, rather than in the cockpit beside it. Nothing else in the harness depends on it, and it may be
withdrawn or reshaped whole once it has been tried — a decision to keep it is the change that removes
this marker.

An operator on a team that works in Azure DevOps spends the day on its pull request list, not in the
cockpit. The question that list cannot answer is **which of these is the fleet working on right now**.
The overlay answers it in place: a badge on each pull request row that has a live agent on it, naming
how many and, on hover, what each is doing.

## Invariants

- **An agent is on a pull request by its origin, read through a job, or else by its branch.** A `pr:<n>` origin (any suffix) names the pull request; a `job:<id>` origin is read through to the work it redoes; failing both, a task whose branch is an open pull request's branch is on that pull request. Only live agents count. → [§](#which-pull-request-an-agent-is-on) · `test/prAgents.test.ts`
- **The bridge answers only its own parent, and only when that parent is Azure DevOps.** It replies to a message whose source is the embedding window and whose origin is `https://dev.azure.com` or `https://<org>.visualstudio.com`, and posts back to that origin alone. → [§](#the-bridge) · _no test_
- **The bridge holds no data and no credential of its own.** It is a static page outside the `/api` guard, like the SPA shell; the token arrives in the URL fragment the bookmarklet built, and its one fetch is a same-origin, bearer-carrying `/api` call the guard authorizes as usual. → [§](#the-bridge) · _no test_

## Why a bridge

The obvious shape — the bookmarklet `fetch`es LubbDubb from the Azure DevOps page — is refused by
Azure DevOps' Content Security Policy: its `connect-src` names no loopback address, so the request never
leaves the browser. That was tried first, and is why this shape exists. A browser add-on or a userscript
manager would sidestep it, but neither is something an operator on a locked-down work machine can
install; a bookmark is.

The same policy **does** allow a loopback page in an `<iframe>`, and `postMessage` between windows is
outside CSP altogether. So the data is fetched by a LubbDubb page — same-origin with the API it calls,
so neither CSP nor CORS is involved — and handed to the Azure DevOps page as a message. Nothing about
the server's own authentication changes ([16](16-http-api.md#authentication)): no CORS header is
added, and the Origin check never sees the Azure DevOps origin, because the request is the iframe's.

## Which pull request an agent is on

`GET /api/prs/agents` answers `{ prs: [{ number, agents: [{ id, status, title, waitingReason }] }] }`,
ordered by pull request number. It is `prAgents` in `src/server/prAgents.ts`, a pure function over the
live agents (`starting`, `running`, `waiting`), their tasks, the jobs a requeue points through, and the
open pull requests of the persisted world baseline — never a provider read, for the reason
[`GET /api/state`](16-http-api.md#get-apistate) is not one.

The match is the cheap one, deliberately: the origin first, because a review reply or a merge-conflict
fix is dispatched at `pr:<n>…` and that is exact; then the task's branch, because a code agent building
an issue is dispatched at `issue:<n>` but pushes to the branch its pull request is open from. A job
origin is read through first (`standsFor`, up to four hops), or a crash recovery's requeue would show
the pull request as unstaffed — the same reason the cockpit reads origins through it
([17](17-cockpit.md#a-job-origin-stands-in-for-other-work)). It is not the cockpit's goal-level match
(`ownsPr`); the overlay asks only what is on each pull request, not which goal owns it.

It is its own route rather than a section of `/api/state` because the overlay polls it every minute
from every Azure DevOps tab the operator leaves open, and the snapshot is the largest response the
server sends.

## The bridge

`web/public/ado-bridge.html` is copied into `web/dist` by the cockpit build and served by the static
plugin as `/ado-bridge.html`. It reads the token from `#t=` in its own address, listens for a
`{ type: 'lubbdubb:pr-agents' }` message, fetches `/api/prs/agents` with the token as a bearer, and
posts `{ type: 'lubbdubb:pr-agents', ok, data | error }` back to the window that asked.

**The origin check is what keeps it from being a data leak.** Any site could embed the page; one that
does gets nothing, both because it does not hold the token and because the bridge ignores a message
from an origin that is not Azure DevOps. `https://dev.azure.com` is shared by every organization, which
is acceptable here: the pages it serves are Azure DevOps' own, and an extension's code runs on a
separate origin.

The token in the bookmark is the cockpit token in plain text — anyone who can read the operator's
bookmarks can read it. That is the price of not being able to install anything, and the reason the
overlay is an experiment rather than the way LubbDubb ships into Azure DevOps.

## The bookmarklet

Set `L` to the cockpit's address exactly as the browser shows it (`127.0.0.1` and `localhost` are
different origins) and `T` to the cockpit token (`LUBBDUBB_TOKEN`, or the `auth.tokenFile`). Clicked on
a repository's pull request list, it adds the hidden bridge, asks it for the data on load and every
minute after, and badges each row whose pull request has agents. Clicked again, it refreshes at once.

```
javascript:(()=>{if(window.__ld){window.__ld();return}const L='http://127.0.0.1:4300',T='PASTE_TOKEN';const f=document.createElement('iframe');f.style.display='none';f.src=L+'/ado-bridge.html#t='+T;document.body.appendChild(f);let d={};const tag=()=>document.querySelectorAll('a.bolt-table-row[href*="/pullrequest/"]').forEach(a=>{if(a.querySelector('.ld-badge'))return;const n=(/pullrequest\/(\d+)/.exec(a.getAttribute('href'))||[])[1];const ag=d[n];if(!ag)return;const t=a.querySelector('.bolt-table-two-line-cell-item .body-l');if(!t)return;const w=ag.some(x=>x.status==='waiting');const b=document.createElement('span');b.className='ld-badge flex-noshrink margin-left-4';b.textContent=(w?'⏳ ':'🤖 ')+ag.length+' agent'+(ag.length>1?'s':'');b.title=ag.map(x=>x.status+': '+x.title+(x.waitingReason?' — '+x.waitingReason:'')).join('\n');b.style.cssText='padding:1px 8px;border-radius:10px;color:#fff;font-size:11px;align-self:center;background:'+(w?'#b8860b':'#5b2bd6');t.after(b)});addEventListener('message',e=>{if(e.origin!==L||!e.data||e.data.type!=='lubbdubb:pr-agents')return;if(!e.data.ok){console.warn('LubbDubb overlay:',e.data.error);return}d={};e.data.data.prs.forEach(p=>d[p.number]=p.agents);document.querySelectorAll('.ld-badge').forEach(x=>x.remove());tag()});const ask=()=>f.contentWindow.postMessage({type:'lubbdubb:pr-agents'},L);f.onload=ask;setInterval(ask,60000);new MutationObserver(tag).observe(document.body,{childList:true,subtree:true});window.__ld=ask})();
```

The row and title selectors (`a.bolt-table-row`, `.bolt-table-two-line-cell-item .body-l`) are Azure
DevOps' own markup, read off the live page, and nothing promises they stay. When the badges stop
appearing, that is the first place to look. A badge is purple for working agents and amber when any of
them is waiting on a person.
