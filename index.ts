// supabase/functions/api-proxy/index.ts
// Helper for Tuntas. Forwards an API request on behalf of a signed-in user, so that
//   (1) the API's CORS rules do not matter, and
//   (2) API keys can stay on the server instead of inside the web app.
//
// Deploy:   supabase functions deploy api-proxy
//
// Server-side keys (optional, recommended). Store them ONCE as a secret; each key is bound
// to one host and is never sent anywhere else. A key is sent either as an HTTP header ("header")
// or as a URL parameter ("param"):
//   supabase secrets set API_SECRETS='{
//     "apiindonesia":     {"host":"use.apiindonesia.id",      "header":"x-api-key", "value":"KEY"},
//     "gnews":            {"host":"gnews.io",                 "param":"apikey",     "value":"KEY"},
//     "tradingeconomics": {"host":"api.tradingeconomics.com", "param":"c",          "value":"KEY:SECRET"},
//     "outlook":          {"host":"outlook.office365.com",    "url":"https://outlook.office365.com/owa/calendar/.../calendar.ics"}}'
// A secret with a "url" is a link that IS the secret (e.g. a published calendar): the app only sends the name
// and this function fetches the stored address, so the link never reaches the browser.
// The web app then asks for a key by name (e.g. "gnews"); the key itself never reaches the browser.
//
// Optional host allow-list (any public host is allowed when it is not set):
//   supabase secrets set ALLOWED_HOSTS=use.apiindonesia.id,api.example.com
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Block localhost, private ranges, link-local and any IPv6 literal.
const privateHost = (h: string) =>
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h) ||
  /^\[/.test(h) ||
  /\.(internal|local|localhost)$/i.test(h);

type Secret = { host: string; header?: string; param?: string; url?: string; value?: string };
const loadSecrets = (): Record<string, Secret> => {
  try {
    return JSON.parse(Deno.env.get("API_SECRETS") ?? "{}");
  } catch {
    return {};
  }
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return reply({ error: "Please sign in first." }, 401);

    const { url, method = "GET", headers = {}, body, secretName } = await req.json();
    const allowed = (Deno.env.get("ALLOWED_HOSTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

    let secret: Secret | null = null;
    if (secretName) {
      secret = loadSecrets()[String(secretName)] ?? null;
      if (!secret || !(secret.value || secret.url) || !secret.host) {
        return reply({ error: 'No server-side secret named "' + secretName + '". Set it with: supabase secrets set API_SECRETS=...' }, 400);
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
