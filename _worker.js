// Stickman Studio backend (Cloudflare Pages "advanced mode").
// Routes: POST /api/ai, /api/transcribe, /api/tts, /api/image, /api/cloud. Everything else serves your site.
// Needs: Workers AI binding named "AI". Optional R2 binding named "BUCKET" (cloud project saving). Optional secrets: PASSCODE, ANTHROPIC_API_KEY, CLAUDE_MODEL.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const LIMIT_MSG =
  'Your free Cloudflare AI allowance for today is used up. It resets at midnight UTC (3:00 AM Ethiopia time). Meanwhile use a Budget voice (cheap), or upgrade Workers AI to paid.';

const toBase64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 32768) {
    s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
  }
  return btoa(s);
};

const fromBase64 = (s) => {
  const clean = String(s).replace(/^data:[^,]+,/, '');
  return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
};

async function ai(request, env) {
  let prompt;
  try {
    ({ prompt } = await request.json());
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!prompt || typeof prompt !== 'string') return json({ error: 'missing prompt' }, 400);
  if (prompt.length > 60000) return json({ error: 'prompt too long' }, 413);

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
    return json({ text: (d.content || []).map((b) => b.text || '').join('') });
  }
  if (env.AI) {
    const d = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
    });
    const out = d.response;
    return json({ text: typeof out === 'string' ? out : JSON.stringify(out ?? '') });
  }
  return json({ error: 'no AI backend configured' }, 500);
}

async function transcribe(request, env) {
  if (!env.AI) return json({ error: 'AI binding not configured' }, 500);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'empty audio' }, 400);
  if (buf.byteLength > 25 * 1024 * 1024) {
    return json({ error: 'audio too large (max 25 MB). Use an .srt instead.' }, 413);
  }
  const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
    audio: toBase64(buf),
    vad_filter: true,
  });
  return json({ text: r.text || '', vtt: r.vtt || '', segments: r.segments || [] });
}

const AURA_VOICES = [
  'angus', 'asteria', 'arcas', 'orion', 'orpheus', 'athena',
  'luna', 'zeus', 'perseus', 'helios', 'hera', 'stella',
];

// Turn whatever Workers AI returns into an audio/mpeg response.
async function audioResponse(out) {
  const headers = { 'content-type': 'audio/mpeg' };
  if (out instanceof Response) {
    if (out.status === 429) return json({ error: LIMIT_MSG }, 429);
    if (!out.ok) return json({ error: 'tts failed (' + out.status + ')' }, 502);
    return new Response(out.body, { headers });
  }
  if (out && typeof out === 'object' && typeof out.audio === 'string') {
    return new Response(fromBase64(out.audio), { headers });
  }
  if (typeof out === 'string') return new Response(fromBase64(out), { headers });
  if (out instanceof ArrayBuffer || ArrayBuffer.isView(out) || out instanceof ReadableStream) {
    return new Response(out, { headers });
  }
  return json({ error: 'unexpected tts output' }, 502);
}

async function tts(request, env) {
  if (!env.AI) return json({ error: 'AI binding not configured' }, 500);
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const text = String(b.text || '').trim().slice(0, 1500);
  if (!text) return json({ error: 'missing text' }, 400);

  const [kind, val] = String(b.voice || 'aura:asteria').split(':');

  if (kind === 'melo') {
    const out = await env.AI.run('@cf/myshell-ai/melotts', { prompt: text, lang: val || 'en' });
    return audioResponse(out);
  }

  const speaker = AURA_VOICES.includes(val) ? val : 'asteria';
  const out = await env.AI.run(
    '@cf/deepgram/aura-1',
    { text, speaker, encoding: 'mp3' },
    { returnRawResponse: true }
  );
  return audioResponse(out);
}

async function image(request, env) {
  if (!env.AI) return json({ error: 'AI binding not configured' }, 500);
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const prompt = String(b.prompt || '').trim().slice(0, 1900);
  if (!prompt) return json({ error: 'missing prompt' }, 400);
  const steps = Math.max(1, Math.min(8, parseInt(b.steps, 10) || 4));
  const out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, steps });
  const img = out && (out.image || (typeof out === 'string' ? out : ''));
  if (!img) return json({ error: 'image model returned nothing' }, 502);
  return json({ image: img });
}

// Cloud project saving in R2. POST /api/cloud?op=list|put|get|del&name=...
async function cloud(request, env) {
  if (!env.BUCKET) {
    return json({ error: 'Cloud saving is not set up. Add an R2 binding named BUCKET.' }, 501);
  }
  const u = new URL(request.url);
  const op = u.searchParams.get('op') || 'list';
  const name = (u.searchParams.get('name') || '').replace(/[^\w .()-]/g, '_').slice(0, 80);
  if (op === 'list') {
    const l = await env.BUCKET.list({ prefix: 'projects/' });
    return json({
      items: l.objects.map((o) => ({
        name: o.key.slice(9).replace(/\.json$/, ''),
        size: o.size,
        at: o.uploaded,
      })),
    });
  }
  if (!name) return json({ error: 'missing name' }, 400);
  const key = 'projects/' + name + '.json';
  if (op === 'put') {
    if (!request.body) return json({ error: 'empty body' }, 400);
    await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true });
  }
  if (op === 'get') {
    const o = await env.BUCKET.get(key);
    if (!o) return json({ error: 'not found' }, 404);
    return new Response(o.body, { headers: { 'content-type': 'application/json' } });
  }
  if (op === 'del') {
    await env.BUCKET.delete(key);
    return json({ ok: true });
  }
  return json({ error: 'unknown op' }, 400);
}

const ROUTES = { '/api/ai': ai, '/api/transcribe': transcribe, '/api/tts': tts,
  '/api/image': image,
  '/api/cloud': cloud,
};

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const handler = ROUTES[path];

    if (handler) {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      if (env.PASSCODE && request.headers.get('x-pass') !== env.PASSCODE) {
        return json({ error: 'unauthorized' }, 401);
      }
      try {
        return await handler(request, env);
      } catch (e) {
        const m = String(e.message || e);
        if (/429|limit|quota|capacity|neurons/i.test(m)) return json({ error: LIMIT_MSG }, 429);
        return json({ error: m }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
