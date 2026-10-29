// POST /api/ai  { prompt }  ->  { text }
// Used by "Match with AI" and "Doc Starter".
//
// Backend choice:
//   - If the ANTHROPIC_API_KEY secret is set, it calls Claude.
//   - Otherwise it uses Cloudflare Workers AI (needs the "AI" binding, no key).
//
// Optional secret PASSCODE: if set, requests must send a matching x-pass header.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export async function onRequestPost({ request, env }) {
  if (env.PASSCODE && request.headers.get('x-pass') !== env.PASSCODE) {
    return json({ error: 'unauthorized' }, 401);
  }

  let prompt;
  try {
    ({ prompt } = await request.json());
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!prompt || typeof prompt !== 'string') return json({ error: 'missing prompt' }, 400);
  if (prompt.length > 60000) return json({ error: 'prompt too long' }, 413);

  try {
    let text;

    if (env.ANTHROPIC_API_KEY) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!r.ok) return json({ error: 'claude api ' + r.status }, 502);
      const d = await r.json();
      text = (d.content || []).map((b) => b.text || '').join('');
    } else if (env.AI) {
      const d = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3000,
      });
      text = d.response || '';
    } else {
      return json({ error: 'no AI backend configured (add the AI binding or ANTHROPIC_API_KEY)' }, 500);
    }

    return json({ text });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

export const onRequest = () => json({ error: 'POST only' }, 405);
