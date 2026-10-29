# piagent-harness

Company harness for Piagent company mode: completion gate, review helpers, ledger, team memory, reports to Studio.

Part of the Piagent company-mode bundle for stock [Pi](https://github.com/earendil-works) (pinned: `@earendil-works/pi-coding-agent` 1.3.0). See `piagent-bundle/docs` for the plan, contracts and runbook.

Status: phase 2.3 implemented and tested against fakes (`npm test`, offline). Not yet run together with the real `piagent-provider` and `piagent-sandbox`; see "Not verified" below.

## What it does

| Area | Modules |
|---|---|
| Completion gate (check on the final code, review, send-backs) | `workflow`, `checks`, `risk-lanes`, `patch` |
| Checklist and "continue" (up to 30 steps, stops after 2 idle rounds) | `plan`, `continuation` |
| Helpers: scout, research, verify, review (read-only child Pi sessions, own grant, result through a schema tool) | `helper-roles`, `helper-results`, `helper-run`, `helper-settlement`, `children`, `copies` |
| Objection ledger and brief objections | `ledger`, `objections` |
| Questions to the member (`ask_user`) | `member-questions` |
| Team memory, `memory_ask`, evidence-only lessons, skill proposals | `memory`, `memory-repos`, `memory-outbox`, `memory-lessons`, `skill-feedback` |
| Reports to Studio (process v1-v3, failed tools) | `report`, `tool-failures` |
| Compaction at 90% of the window, at most 300k tokens, plan kept | `compaction` |
| Company terminal (header, footer without USD, `/style`, state file for Agent Watch) | `ui`, `status-file` |
| Core tools must come from `piagent-sandbox` (`sourceInfo`) | `guard` |
| Talking to the other packages | `bus`, `studio` (see `piagent-bundle/docs/package-contract.md`) |

Load order for Pi: `pi --no-extensions -e piagent-harness -e piagent-sandbox -e piagent-provider`. The harness never imports the other packages; it only uses `pi.events` channels and never holds a token (Studio calls go through the provider).

## Not verified

- Child helper sessions against the real provider (`grant.request` with `role: child`) and the real sandbox (`piagent:tools.child`): tested with fake bus replies only.
- The `sourceInfo` check against the real sandbox's attestation: tested with a fake extension registering `bash`.
- A full run in Pi 1.3.0's Terminal (header, footer, `/style`, `ask_user` selectors): the logic is tested with fake UI objects.
- Studio endpoints (memory, settle, tool failures) against a real Studio: tested with a stub.
- Multi-repository folders for team memory (one repository per folder only).

## Development

```bash
npm ci
npm test
```

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately.
