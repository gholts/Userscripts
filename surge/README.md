`JMS Bandwidth` arguments:

- `interval`: panel update interval. Default `3600`.
- `host`: Just My Socks host. Default `justmysocks6.net`.
- `service`: required `service` value from the bandwidth URL.
- `id`: required `id` value from the bandwidth URL.
- `policy`: request policy. Default `DIRECT`.
- `unit`: `GB` or `GiB`. Default `GB`.
- `timeout`: script and request timeout. Default `8`.

For `https://justmysocks6.net/members/getbwcounter.php?service=123&id=abc`, use:

- `host`: `justmysocks6.net`
- `service`: `123`
- `id`: `abc`

`OpenAI Codex Usage` arguments:

- `interval`: panel update interval. Default `300`.
- `access-token`: required `tokens.access_token` from `~/.codex/auth.json`, or a Codex personal access token.
- `account-id`: optional `tokens.account_id` from `~/.codex/auth.json` for workspace accounts. Default `-`.
- `base-url`: default `chatgpt.com`; full URLs also work.
- `policy`: request policy. Default `DIRECT`.
- `timeout`: script and request timeout. Default `8`.

Codex panel only calls `GET https://chatgpt.com/backend-api/wham/usage` or equivalent `GET /api/codex/usage`. It does not call model, responses, or turn endpoints, so checking remaining usage should not consume Codex usage.
