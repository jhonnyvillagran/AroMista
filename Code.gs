function sanitizeCell(value) {
  if (value === null || value === undefined) return '';
  var str = String(value).trim();
  if (/^[=+\-@\t\r]/.test(str)) return "'" + str;
  return str;
}

function getCatalogSheet(ss) {
  return ss.getSheetByName('Aromista.uy') || ss.getSheetByName('Productos') || ss.getSheets()[0];
}

function ensureSheetWithHeaders(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function verifyBlogAdmin(pass) {
  var expected = PropertiesService.getScriptProperties().getProperty('BLOG_ADMIN_PASSWORD');
  if (!expected) throw new Error('Configura BLOG_ADMIN_PASSWORD en Propiedades del Script.');
  if (!pass || String(pass) !== String(expected)) throw new Error('Contraseña de administrador incorrecta.');
}

function saveBlogImageToDrive(imageUpload) {
  var folders = DriveApp.getFoldersByName('AroMista Blog Images');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('AroMista Blog Images');
  var bytes = Utilities.base64Decode(imageUpload.base64);
  var blob = Utilities.newBlob(bytes, imageUpload.mimeType || 'image/jpeg', imageUpload.fileName || ('blog-' + Date.now() + '.jpg'));
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1200';
}

function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action) : '';

    if (action === 'getBlog') {
      var blogSheet = ss.getSheetByName('Blog');
      if (!blogSheet) return jsonResponse([]);
      var bData = blogSheet.getDataRange().getValues();
      if (bData.length <= 1) return jsonResponse([]);
      var bHeaders = bData[0].map(function(h) { return String(h).trim(); });
      var posts = [];
      for (var i = 1; i < bData.length; i++) {
        if (!bData[i][0] && !bData[i][1]) continue;
        var postObj = {};
        for (var j = 0; j < bHeaders.length; j++) postObj[bHeaders[j]] = bData[i][j];
        posts.push(postObj);
      }
      return jsonResponse(posts);
    }

    var sheet = getCatalogSheet(ss);
    if (!sheet) return jsonResponse({ status: 'error', message: 'No se encontró la hoja del catálogo.' });
    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return jsonResponse([]);
    var headers = data[0].map(function(h) { return String(h).trim(); });
    var products = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (!row[0] && !row[1]) continue;
      var item = {};
      for (var c = 0; c < headers.length; c++) {
        var key = headers[c];
        var val = row[c];
        if (key.toLowerCase() === 'images') {
          item.images = String(val || '').split(/[\n,]+/).map(function(u) { return u.trim(); }).filter(Boolean);
        } else if (key.toLowerCase() === 'name') {
          item.name = String(val || '').trim();
        } else {
          item[key] = val;
        }
      }
      products.push(item);
    }
    return jsonResponse(products);
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var body = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : '{}');
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (body.action === 'registerUser') {
      var clientSheet = ensureSheetWithHeaders(ss, 'Clientes', ['Fecha', 'Nombre', 'Email', 'Cedula', 'Direccion', 'Agencia']);
      clientSheet.appendRow([new Date(), sanitizeCell(body.name), sanitizeCell(body.email), sanitizeCell(body.cedula), sanitizeCell(body.direccion), sanitizeCell(body.agencia)]);
      return jsonResponse({ status: 'ok', message: 'Cliente registrado.' });
    }

    if (body.action === 'reduceStock' || body.action === 'confirmOrder') {
      var prodSheet = getCatalogSheet(ss);
      var orderSheet = ensureSheetWithHeaders(ss, 'Pedidos', ['Fecha', 'PaymentID', 'ExternalReference', 'Estado', 'Total_UYU', 'Items', 'Cliente_Email', 'Cliente_Nombre', 'Cedula', 'Direccion', 'Agencia']);
      var paymentId = String(body.paymentId || '').trim();
      var extRef = String(body.externalReference || '').trim();
      if (paymentId) {
        var orderData = orderSheet.getDataRange().getValues();
        for (var k = 1; k < orderData.length; k++) {
          if (String(orderData[k][1]).trim() === paymentId) return jsonResponse({ status: 'ok', duplicate: true, message: 'Pago ya procesado.' });
        }
      }
      var items = Array.isArray(body.items) ? body.items : [];
      var prodData = prodSheet.getDataRange().getValues();
      var headersLower = prodData[0].map(function(h) { return String(h).trim().toLowerCase(); });
      var idCol = headersLower.indexOf('id'), stockCol = headersLower.indexOf('stock');
      if (idCol === -1 || stockCol === -1) throw new Error('La hoja debe tener columnas id y Stock.');
      for (var m = 0; m < items.length; m++) {
        var reqId = String(items[m].id || '').trim(), qty = parseInt(items[m].quantity, 10) || 0;
        if (!reqId || qty <= 0) continue;
        for (var r = 1; r < prodData.length; r++) {
          if (String(prodData[r][idCol]).trim() === reqId) {
            var rawStock = prodData[r][stockCol];
            if (rawStock !== '' && rawStock !== null && rawStock !== undefined) {
              var curr = parseInt(rawStock, 10);
              if (!isNaN(curr)) prodSheet.getRange(r + 1, stockCol + 1).setValue(Math.max(0, curr - qty));
            }
            break;
          }
        }
      }
      var summaryItems = items.map(function(i) { return (i.title || i.id) + ' x' + i.quantity; }).join(' | ');
      var payer = body.payer || {};
      orderSheet.appendRow([new Date(), sanitizeCell(paymentId || 'N/A'), sanitizeCell(extRef || 'N/A'), sanitizeCell(body.status || 'approved'), Number(body.totalAmount || 0), sanitizeCell(summaryItems), sanitizeCell(payer.email || ''), sanitizeCell(payer.name || ''), sanitizeCell(payer.cedula || ''), sanitizeCell(payer.address || payer.direccion || ''), sanitizeCell(payer.agency || payer.agencia || '')]);
      return jsonResponse({ status: 'ok', message: 'Stock descontado y pedido registrado.' });
    }

    if (body.action === 'saveBlogPost') {
      verifyBlogAdmin(body.adminPassword);
      var blogSheet = ensureSheetWithHeaders(ss, 'Blog', ['id', 'title', 'author', 'imageUrl', 'imageCredit', 'summary', 'intro', 'content', 'updatedAt']);
      var post = body.post || {};
      var finalImageUrl = post.imageUrl || 'Logo.png';
      if (body.imageUpload && body.imageUpload.base64) finalImageUrl = saveBlogImageToDrive(body.imageUpload);
      var bRows = blogSheet.getDataRange().getValues(), rowIndex = -1;
      for (var b = 1; b < bRows.length; b++) { if (String(bRows[b][0]).trim() === String(post.id).trim()) { rowIndex = b + 1; break; } }
      var rowValues = [sanitizeCell(post.id), sanitizeCell(post.title), sanitizeCell(post.author), sanitizeCell(finalImageUrl), sanitizeCell(post.imageCredit || 'AroMista'), sanitizeCell(post.summary), sanitizeCell(post.intro), sanitizeCell(post.content), new Date()];
      if (rowIndex > 0) blogSheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
      else blogSheet.appendRow(rowValues);
      return jsonResponse({ status: 'ok', imageUrl: finalImageUrl });
    }

    if (body.action === 'deleteBlogPost') {
      verifyBlogAdmin(body.adminPassword);
      var delSheet = ss.getSheetByName('Blog');
      if (!delSheet) return jsonResponse({ status: 'ok' });
      var dRows = delSheet.getDataRange().getValues();
      for (var d = dRows.length - 1; d >= 1; d--) { if (String(dRows[d][0]).trim() === String(body.id).trim()) delSheet.deleteRow(d + 1); }
      return jsonResponse({ status: 'ok' });
    }

    if (body.action === 'seedBlog') {
      verifyBlogAdmin(body.adminPassword);
      var sSheet = ensureSheetWithHeaders(ss, 'Blog', ['id', 'title', 'author', 'imageUrl', 'imageCredit', 'summary', 'intro', 'content', 'updatedAt']);
      if (sSheet.getLastRow() <= 1 && Array.isArray(body.posts)) {
        body.posts.forEach(function(p) { sSheet.appendRow([sanitizeCell(p.id), sanitizeCell(p.title), sanitizeCell(p.author), sanitizeCell(p.imageUrl), sanitizeCell(p.imageCredit), sanitizeCell(p.summary), sanitizeCell(p.intro), sanitizeCell(p.content), new Date()]); });
      }
      return jsonResponse({ status: 'ok' });
    }

    return jsonResponse({ status: 'error', message: 'Acción no reconocida.' });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  } finally { lock.releaseLock(); }
}
