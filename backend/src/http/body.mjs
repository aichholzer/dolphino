const MAX_BODY_BYTES = 1024 * 1024;

export async function body(req, raw = false) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(Error('Request too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks);
  if (raw) {
    return value;
  }
  try {
    return JSON.parse(value.toString() || '{}');
  } catch {
    throw Object.assign(Error('Invalid JSON'), { status: 400 });
  }
}
