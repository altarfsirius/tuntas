// supabase/functions/api-proxy/index.ts
// Helper for Tuntas. Forwards an API request on behalf of a signed-in user, so that
//   (1) the API's CORS rules do not matter, and
//   (2) API keys can stay on the server instead of inside the web app.
//
// Deploy:   supabase functions deploy api-proxy
//
// SERVER-SIDE KEYS (optional, recommended). The easy way is a plain text file with one line per key:
//     APIINDONESIA_KEY=your-key-for-use.apiindonesia.id
//     GNEWS_KEY=your-gnews-key
//     TRADINGECONOMICS_KEY=KEY:SECRET
//     OUTLOOK_ICS_URL=https://outlook.office365.com/owa/calendar/.../calendar.ics
// Save it as api-secrets.txt, then run:   supabase secrets set --env-file api-secrets.txt
// Every line is its own secret, so adding one later never removes the others. A key is only ever
// sent to its own host. The app asks for a key by NAME and the key itself never reaches the browser.
// (OUTLOOK_ICS_URL is a link that IS the secret: the function fetches the stored address itself.)
//
// ADVANCED: API_SECRETS holds the same thing as JSON and also allows other hosts. Its entries win over the lines above:
//   supabase secrets set API_SECRETS='{"myapi":{"host":"api.example.com","header":"x-api-key","value":"KEY"}}'
//
// Optional host allow-list (any public host is allowed when it is not set):
//   supabase secrets set ALLOWED_HOSTS=use.apiindonesia.id,api.example.com
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "2026.10.3";
const baseCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// Allow whatever headers the browser asks for, so a newer supabase-js that adds a header never breaks the preflight.
let cors: Record<string, string> = baseCors;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Block localhost, private ranges, link-local and any IPv6 literal.
const privateHost = (h: string) =>
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h) ||
  /^\[/.test(h) ||
  /\.(internal|local|localhost)$/i.test(h);

type Secret = { host: string; header?: string; param?: string; url?: string; value?: string };
// Values pasted into a text file often carry quotes or the template placeholder; tolerate both.
const clean = (v?: string | null) => {
  const t = (v ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
  return /^PASTE/i.test(t) ? "" : t;
};
const simpleSecrets = (): Record<string, Secret> => {
  const out: Record<string, Secret> = {};
  const a = clean(Deno.env.get("APIINDONESIA_KEY"));
  if (a) out.apiindonesia = { host: "use.apiindonesia.id", header: "x-api-key", value: a };
  const g = clean(Deno.env.get("GNEWS_KEY"));
  if (g) out.gnews = { host: "gnews.io", param: "apikey", value: g };
  const t = clean(Deno.env.get("TRADINGECONOMICS_KEY"));
  if (t) out.tradingeconomics = { host: "api.tradingeconomics.com", param: "c", value: t };
  const o = clean(Deno.env.get("OUTLOOK_ICS_URL"));
  if (o) {
    try {
      const u = new URL(o.replace(/\/calendar\.html(\?.*)?$/i, "/calendar.ics$1"));
      if (u.protocol === "https:") out.outlook = { host: u.hostname, url: u.toString() };
    } catch { /* not a link: ignored */ }
  }
  return out;
};
const loadSecrets = (): Record<string, Secret> => {
  let json: Record<string, Secret> = {};
  try {
    json = JSON.parse(Deno.env.get("API_SECRETS") ?? "{}");
  } catch { /* ignored */ }
  return { ...simpleSecrets(), ...json };
};

Deno.serve(async (req: Request) => {
  cors = { ...baseCors, "Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") || baseCors["Access-Control-Allow-Headers"] };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return reply({ error: "Please sign in first." }, 401);
    // Accounts that an admin switched off (or has not approved yet) must not use the proxy either,
    // even while their sign-in token is still valid. A missing profile table does not block anyone.
    try {
      const { data: prof } = await sb.from("profiles").select("status").eq("id", user.id).maybeSingle();
      if (prof && prof.status && prof.status !== "active") return reply({ error: "This account is not active. Ask an admin." }, 403);
    } catch { /* profiles not readable: carry on */ }

    const { url, method = "GET", headers = {}, body, secretName, ping } = await req.json();
    const allowed = (Deno.env.get("ALLOWED_HOSTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

    // Health check used by the app (Settings → Data feeds → Check the Edge Function): names only, never values.
    if (ping) {
      const all = loadSecrets();
      return reply({
        ok: true,
        version: VERSION,
        secrets: Object.keys(all).map((n) => ({ name: n, kind: all[n].url ? "url" : all[n].param ? "param" : "header" })),
        allowedHosts: allowed.length,
      });
    }

    let secret: Secret | null = null;
    if (secretName) {
      secret = loadSecrets()[String(secretName)] ?? null;
      if (!secret || !(secret.value || secret.url) || !secret.host) {
        return reply({ error: 'No server-side secret named "' + secretName + '". Add its line to api-secrets.txt and run: supabase secrets set --env-file api-secrets.txt' }, 400);
      }
    }

    let target = secret?.url ? new URL(secret.url) : new URL(String(url));
    if (secret?.url && target.hostname !== secret.host) return reply({ error: "This secret may only be used with " + secret.host }, 403);
    for (let hop = 0; ; hop++) {
      if (!["https:", "http:"].includes(target.protocol) || privateHost(target.hostname)) {
        return reply({ error: "This address is not allowed." }, 400);
      }
      if (allowed.length && !allowed.includes(target.hostname)) {
        return reply({ error: "Host not in ALLOWED_HOSTS: " + target.hostname }, 403);
      }
      const h: Record<string, string> = { ...headers };
      let callUrl = target;
      if (secret && !secret.url) {
        // The key is only ever attached to the host it belongs to (also after a redirect).
        if (target.hostname !== secret.host) {
          return reply({ error: "This secret may only be used with " + secret.host }, 403);
        }
        if (secret.param) {
          callUrl = new URL(target.toString());
          callUrl.searchParams.set(secret.param, secret.value!); // replaces anything the client sent
        } else {
          h[secret.header || "x-api-key"] = secret.value!;
        }
      }
      const res = await fetch(callUrl, {
        method,
        headers: h,
        body: method === "GET" ? undefined : body,
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
      });
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc && hop < 3) {
        target = new URL(loc, target);
        continue;
      }
      const text = (await res.text()).slice(0, 5_000_000);
      return reply({ status: res.status, text });
    }
  } catch (e) {
    return reply({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
