const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwsTNoRLk2TPAlS9Uj5BjERUqrdk7lUjmDEEUK4CIYPct2Lxz4gpxB1sskTNs6Np4s/exec';

function parsePrice(item) {
  const raw = item?.price ?? item?.Price ?? item?.precio;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (typeof raw === 'string') {
    const val = parseFloat(raw.replace(/[^0-9,.]/g, '').replace(',', '.'));
    return Number.isFinite(val) && val > 0 ? val : 0;
  }
  return 0;
}

function parseStock(item) {
  const raw = item?.Stock ?? item?.stock ?? item?.cantidad ?? item?.Cantidad;
  if (raw === undefined || raw === null || String(raw).trim() === '') return 999;
  const num = parseInt(String(raw).trim(), 10);
  return Number.isFinite(num) ? num : 999;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ message: 'Método no permitido' }) };
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) return { statusCode: 500, body: JSON.stringify({ message: 'MP_ACCESS_TOKEN no configurado en Netlify.' }) };
  try {
    const body = JSON.parse(event.body || '{}');
    const requestedItems = Array.isArray(body.items) ? body.items : [];
    if (requestedItems.length === 0) return { statusCode: 400, body: JSON.stringify({ message: 'Carrito vacío.' }) };
    const catalogRes = await fetch(SCRIPT_URL);
    if (!catalogRes.ok) throw new Error('No se pudo verificar el catálogo oficial.');
    const catalog = await catalogRes.json();
    const mpItems = [];
    let serverTotal = 0;
    for (const reqItem of requestedItems) {
      const qty = parseInt(reqItem.quantity, 10);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 50) return { statusCode: 400, body: JSON.stringify({ message: 'Cantidad inválida.' }) };
      const product = catalog.find(p => String(p.id).trim() === String(reqItem.id).trim());
      if (!product) return { statusCode: 400, body: JSON.stringify({ message: 'Producto inexistente.' }) };
      const unitPrice = parsePrice(product), stock = parseStock(product);
      if (unitPrice <= 0) continue;
      if (stock < qty) return { statusCode: 409, body: JSON.stringify({ message: `Stock insuficiente para ${product.name}. Disponible: ${stock}` }) };
      serverTotal += unitPrice * qty;
      mpItems.push({ id: String(product.id).trim(), title: String(product.name).trim().slice(0, 120), quantity: qty, currency_id: 'UYU', unit_price: Number(unitPrice.toFixed(2)) });
    }
    if (mpItems.length === 0) return { statusCode: 400, body: JSON.stringify({ message: 'No hay artículos con precio fijo.' }) };
    const host = event.headers.host;
    const protocol = host && host.includes('localhost') ? 'http' : 'https';
    const notificationUrl = host ? `${protocol}://${host}/.netlify/functions/mp-webhook` : undefined;
    const mpPayload = {
      items: mpItems,
      payer: { name: String(body.payer?.name || '').slice(0, 80), email: String(body.payer?.email || '').slice(0, 120), identification: { type: 'CI', number: String(body.payer?.cedula || '').replace(/\D/g, '') } },
      external_reference: String(body.externalReference || `ARO-${Date.now()}`).slice(0, 60),
      back_urls: { success: body.backUrls?.success, pending: body.backUrls?.pending, failure: body.backUrls?.failure },
      auto_return: 'approved',
      statement_descriptor: 'AROMISTA UY',
      notification_url: notificationUrl,
      metadata: { items_compact: mpItems.map(i => ({ id: i.id, title: i.title, quantity: i.quantity })), payer_name: String(body.payer?.name || '').slice(0, 80), payer_email: String(body.payer?.email || '').slice(0, 120), shipping_address: String(body.payer?.address || '').slice(0, 160), shipping_agency: String(body.payer?.agency || '').slice(0, 60), cedula_uy: String(body.payer?.cedula || '').replace(/\D/g, '') },
      payment_methods: { installments: 12 }
    };
    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', { method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(mpPayload) });
    const mpData = await mpRes.json();
    if (!mpRes.ok || !mpData.id) throw new Error(mpData.message || 'Error al crear preferencia en Mercado Pago.');
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preferenceId: mpData.id, initPoint: mpData.init_point, serverTotal: Number(serverTotal.toFixed(2)) }) };
  } catch (err) { return { statusCode: 500, body: JSON.stringify({ message: err.message || 'Error interno.' }) }; }
};
