const crypto = require('crypto');
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwsTNoRLk2TPAlS9Uj5BjERUqrdk7lUjmDEEUK4CIYPct2Lxz4gpxB1sskTNs6Np4s/exec';

function verifyWebhookSignature(event, secret) {
  if (!secret) return false;
  const xSignature = event.headers['x-signature'] || event.headers['X-Signature'];
  const xRequestId = event.headers['x-request-id'] || event.headers['X-Request-Id'];
  const qs = event.queryStringParameters || {};
  const dataId = qs['data.id'] || qs.id;
  if (!xSignature || !xRequestId || !dataId) return false;
  const parts = {};
  xSignature.split(',').forEach(part => { const [k, v] = part.split('=').map(s => s.trim()); if (k && v) parts[k] = v; });
  if (!parts.ts || !parts.v1) return false;
  const normalizedId = /^[a-zA-Z0-9]+$/.test(dataId) ? dataId.toLowerCase() : dataId;
  const manifest = `id:${normalizedId};request-id:${xRequestId};ts:${parts.ts};`;
  const expectedHmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const expected = Buffer.from(expectedHmac, 'hex');
  const received = Buffer.from(parts.v1, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const accessToken = process.env.MP_ACCESS_TOKEN, webhookSecret = process.env.MP_WEBHOOK_SECRET || '';
  if (!accessToken || !webhookSecret) return { statusCode: 500, body: 'Missing Mercado Pago environment variables' };
  try {
    if (!verifyWebhookSignature(event, webhookSecret)) return { statusCode: 401, body: 'Invalid signature' };
    const body = JSON.parse(event.body || '{}'), qs = event.queryStringParameters || {};
    const topic = body.type || body.topic || qs.type || qs.topic;
    const paymentId = body.data?.id || qs['data.id'] || qs.id;
    if (topic !== 'payment' || !paymentId) return { statusCode: 200, body: 'Ignored event' };
    const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    if (!paymentRes.ok) return { statusCode: 200, body: 'Payment lookup deferred' };
    const payment = await paymentRes.json();
    if (payment.status !== 'approved') return { statusCode: 200, body: `Status: ${payment.status}` };
    const meta = payment.metadata || {};
    const items = Array.isArray(meta.items_compact) ? meta.items_compact : (payment.additional_info?.items || []).map(i => ({ id: i.id, title: i.title, quantity: parseInt(i.quantity, 10) || 1 }));
    await fetch(SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'confirmOrder',
        paymentId: String(payment.id),
        externalReference: payment.external_reference || '',
        status: payment.status,
        totalAmount: payment.transaction_amount || 0,
        items,
        payer: { name: meta.payer_name || '', email: meta.payer_email || payment.payer?.email || '', cedula: meta.cedula_uy || '', address: meta.shipping_address || '', agency: meta.shipping_agency || '' }
      })
    });
    return { statusCode: 200, body: 'OK' };
  } catch (err) { return { statusCode: 500, body: 'Internal Error' }; }
};
