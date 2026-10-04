# Rock Paper Scissors vs Clef

### ▶️ Play / test it live: **https://rps.orcuncandan.com**

A tiny web game where your webcam reads your hand gesture and
[Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
(a decision model on Workers AI) is the referee.

> Open the link on a phone or desktop with a camera. The round starts, you
> show ✊ / ✋ / ✌️, and Clef calls the winner.

Clef does the work the game is built around: it takes a webcam frame plus a
fixed set of answers (`rock` / `paper` / `scissors` / `none`) and returns
calibrated probabilities. No pose model, no OCR — just bounded classification.

## How it works

```
browser (canvas frame)  →  Worker /classify  →  env.AI.run(@cf/cloudflare/clef-flash)  →  probabilities
```

- **No countdown:** the camera stays on; the game samples frames while waiting
  and locks a move once Clef is confident (`LOCK_CONF`).
- **Motion gate:** a static scene is skipped client-side, so Clef is only
  called on real movement — no wasted tokens.

## Security & cost controls

- **No API keys anywhere.** The Worker reaches Clef through the `AI` binding;
  nothing secret touches the client or the source.
- **Global daily budget** (`GLOBAL_DAILY`) via a Durable Object counter, kept
  under the Workers AI free allocation — exhaustion returns a friendly message
  instead of billing/failing mid-call.
- **Per-IP daily quota** (`PER_IP_DAILY`) + **per-minute rate limit** (native
  rate-limit binding) + **same-origin guard** + request size validation.
- Errors are logged server-side only (`wrangler tail`), never returned to clients.

Tunables live at the top of `src/index.js` (budgets) and in the `<script>` of
`public/index.html` (`LOCK_CONF`, `POLL_MS`, `MOTION_MIN`).

## Develop & deploy

```bash
npm install
npx wrangler login
npx wrangler dev      # http://127.0.0.1:8787  (camera works on localhost)
npx wrangler deploy   # publishes to the custom domain in wrangler.jsonc
```

Camera (`getUserMedia`) requires HTTPS or localhost.
