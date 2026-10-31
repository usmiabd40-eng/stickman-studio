const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const toBase64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 32768) {
    s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
  }
  return btoa(s);
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
    return json({ text: d.response || '' });
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

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    if (path === '/api/ai' || path === '/api/transcribe') {
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      if (env.PASSCODE && request.headers.get('x-pass') !== env.PASSCODE) {
        return json({ error: 'unauthorized' }, 401);
      }
      try {
        return path === '/api/ai' ? await ai(request, env) : await transcribe(request, env);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
