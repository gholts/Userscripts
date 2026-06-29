`JMS Bandwidth` arguments:

- `title`: panel title. Default `JMS Bandwidth`.
- `interval`: panel update interval. Default `3600`.
- `api-url-b64`: required base64url of the Just My Socks API bandwidth URL.
- `policy`: request policy. Default `DIRECT`.
- `unit`: `GB` or `GiB`. Default `GB`.
- `timeout`: script and request timeout. Default `8`.

`OpenAI Codex Usage` arguments:

- `title`: panel title. Default `Codex Usage`.
- `interval`: panel update interval. Default `300`.
- `access-token`: required `tokens.access_token` from `~/.codex/auth.json`, or a Codex personal access token.
- `account-id`: optional `tokens.account_id` from `~/.codex/auth.json` for workspace accounts.
- `base-url`: default `https://chatgpt.com`.
- `policy`: request policy. Default `DIRECT`.
- `timeout`: script and request timeout. Default `8`.

Codex panel only calls `GET https://chatgpt.com/backend-api/wham/usage` or equivalent `GET /api/codex/usage`. It does not call model, responses, or turn endpoints, so checking remaining usage should not consume Codex usage.
