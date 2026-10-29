// POST /api/transcribe  (body = raw audio bytes)  ->  { vtt, segments, text }
// Used by "Auto-captions from narration". Runs Whisper on Cloudflare Workers AI
// (needs the "AI" binding, no API key).
//
// Optional secret PASSCODE: if set, requests must send a matching x-pass header.

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function toBase64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 32768) {
    s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
  }
  return btoa(s);
}

export async function onRequestPost({ request, env }) {
  if (env.PASSCODE && request.headers.get('x-pass') !== env.PASSCODE) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.AI) return json({ error: 'AI binding not configured' }, 500);

  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'empty audio' }, 400);
  if (buf.byteLength > 25 * 1024 * 1024) {
    return json({ error: 'audio too large (max 25 MB). Use an .srt instead.' }, 413);
  }

  try {
    const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: toBase64(buf),
      vad_filter: true,
    });
    return json({
      text: r.text || '',
      vtt: r.vtt || '',
      segments: r.segments || [],
    });
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

export const onRequest = () => json({ error: 'POST only' }, 405);
