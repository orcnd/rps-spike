// Rock-Paper-Scissors vs Clef — Worker API + abuse/budget protection.
// Serves the static game (assets) and one endpoint: POST /classify.

const MODEL = "@cf/cloudflare/clef-flash";

// Daily budgets (protect the Workers AI free allocation: ~10k neurons/day ≈ ~3000 clef-flash calls).
const GLOBAL_DAILY = 2500; // total Clef calls/day across everyone
const PER_IP_DAILY = 120;  // Clef calls/day per visitor
const MAX_IMAGE_CHARS = 1_400_000; // ~1 MB image data URL cap

const ALLOWED_HOSTS = new Set([
  "rps.orcuncandan.com",
  "localhost:8787",
  "127.0.0.1:8787",
]);

const QUESTIONS = {
  gesture: {
    type: "choice",
    instructions:
      "Which single hand gesture is the person clearly making with their hand?",
    criteria: {
      rock: "A closed fist (rock)",
      paper: "An open flat hand, fingers extended (paper)",
      scissors: "A hand showing exactly two fingers in a V (scissors)",
      none: "No hand visible, or no clear rock/paper/scissors gesture",
    },
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/classify") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);

      // Soft same-origin guard: browsers send Origin on JSON POST; block foreign origins.
      const origin = request.headers.get("Origin");
      if (origin) {
        try {
          if (!ALLOWED_HOSTS.has(new URL(origin).host)) return json({ ok: false, error: "forbidden" }, 403);
        } catch { return json({ ok: false, error: "forbidden" }, 403); }
      }

      const ip = request.headers.get("CF-Connecting-IP") || "local";

      // 1) Per-IP burst limit (native, storage-free).
      if (env.BURST) {
        const { success } = await env.BURST.limit({ key: ip });
        if (!success) return json({ ok: false, error: "rate", message: "Too fast — slow down a moment." }, 429);
      }

      // 2) Daily budget (global + per-IP) via Durable Object.
      const stub = env.BUDGET.get(env.BUDGET.idFromName("global"));
      const bRes = await stub.fetch("https://b/consume?ip=" + encodeURIComponent(ip));
      const budget = await bRes.json();
      if (!budget.allowed) {
        const message =
          budget.reason === "daily_global"
            ? "Daily free limit reached. Please come back tomorrow 🙏"
            : "You've hit today's play limit. Come back tomorrow!";
        return json({ ok: false, error: budget.reason, message }, 429);
      }

      // 3) Validate payload.
      let image;
      try {
        ({ image } = await request.json());
      } catch { return json({ ok: false, error: "badjson" }, 400); }
      if (typeof image !== "string" || !image.startsWith("data:image/") || image.length > MAX_IMAGE_CHARS) {
        return json({ ok: false, error: "badimage" }, 400);
      }

      // 4) Call Clef.
      try {
        const t0 = Date.now();
        const result = await env.AI.run(MODEL, {
          model: "clef-flash",
          state: "Classify the hand gesture in this webcam frame.",
          images: [image],
          questions: QUESTIONS,
        });
        return json({ ok: true, ms: Date.now() - t0, remaining: budget.remaining, result });
      } catch (err) {
        // Log details server-side only (visible via `wrangler tail`); never leak internals to clients.
        console.log("clef error:", err && err.stack ? err.stack : String(err));
        return json({ ok: false, error: "server", message: "Something went wrong. Try again." }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

// Durable Object: strongly-consistent daily counter, resets at UTC midnight.
export class Budget {
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const ip = new URL(request.url).searchParams.get("ip") || "?";
    const today = new Date().toISOString().slice(0, 10);
    let d = (await this.state.storage.get("d")) || { day: today, total: 0, ip: {} };
    if (d.day !== today) d = { day: today, total: 0, ip: {} };

    if (d.total >= GLOBAL_DAILY) return json({ allowed: false, reason: "daily_global" });
    if ((d.ip[ip] || 0) >= PER_IP_DAILY) return json({ allowed: false, reason: "daily_ip" });

    d.total += 1;
    d.ip[ip] = (d.ip[ip] || 0) + 1;
    // Keep the per-IP map from growing unbounded.
    const keys = Object.keys(d.ip);
    if (keys.length > 5000) for (const k of keys.slice(0, 1000)) delete d.ip[k];

    await this.state.storage.put("d", d);
    return json({ allowed: true, remaining: GLOBAL_DAILY - d.total });
  }
}
