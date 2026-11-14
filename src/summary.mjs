export function summarize(bytes, mediaType) {
  if (mediaType.includes('application/json')) {
    try {
      const value = JSON.parse(bytes);
      if (value.deliveryId && Array.isArray(value.roots)) return { format: 'delivery-index', deliveryId: value.deliveryId, roots: value.roots.length };
    } catch {}
  }
  return { format: 'sbml', model: bytes.toString('utf8').match(/<model[^>]*id="([^"]+)/)?.[1] || null, byteLength: bytes.length };
}
