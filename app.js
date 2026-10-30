"use strict";

const databaseName = "tienda-inventario-local";
const databaseVersion = 1;
const maximumImportBytes = 2 * 1024 * 1024;
const maximumImportRows = 5000;
const $ = (selector) => document.querySelector(selector);
const state = { database: null, products: [], movements: [], view: "inventory", pendingImport: [], scanTarget: null, mediaStream: null, scanTimer: null, toastTimer: null };

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("products")) {
        const products = database.createObjectStore("products", { keyPath: "id" });
        products.createIndex("name", "name", { unique: false });
      }
      if (!database.objectStoreNames.contains("movements")) {
        const movements = database.createObjectStore("movements", { keyPath: "id" });
        movements.createIndex("createdAt", "createdAt", { unique: false });
        movements.createIndex("productId", "productId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento local."));
    request.onblocked = () => reject(new Error("Cierra otras pestañas de esta app y vuelve a intentarlo."));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("La operación se canceló."));
    transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar el cambio."));
  });
}

function readAll(storeName) {
  return new Promise((resolve, reject) => {
    const request = state.database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudieron leer los datos."));
  });
}

function makeId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizedKey(value) {
  return normalizeText(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1000000000 ? number : null;
}

function formatQuantity(value) {
  return new Intl.NumberFormat("es", { maximumFractionDigits: 3 }).format(value);
}

function formatDate(value, includeTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Fecha desconocida";
  return new Intl.DateTimeFormat("es", includeTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(date);
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove("visible"), 3200);
}

function reportError(error) {
  console.error(error);
  toast(error instanceof Error ? error.message : "Ocurrió un error inesperado.");
}

async function refreshData() {
  const [products, movements] = await Promise.all([readAll("products"), readAll("movements")]);
  state.products = products.sort((left, right) => left.name.localeCompare(right.name, "es"));
  state.movements = movements.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  render();
}

function productStatus(product) {
  if (product.quantity <= 0) return { label: "Agotado", className: "status-empty" };
  if (product.quantity <= product.minStock) return { label: "Stock bajo", className: "status-low" };
  return { label: "Disponible", className: "status-ok" };
}

function renderProducts() {
  const query = normalizeText($("#searchInput").value).toLocaleLowerCase("es");
  const stockFilter = $("#stockFilter").value;
  const products = state.products.filter((product) => {
    const searchable = [product.name, product.sku, product.barcode, product.category].join(" ").toLocaleLowerCase("es");
    if (query && !searchable.includes(query)) return false;
    if (stockFilter === "low" && product.quantity > product.minStock) return false;
    if (stockFilter === "available" && product.quantity <= 0) return false;
    if (stockFilter === "empty" && product.quantity > 0) return false;
    return true;
  });
  const rows = $("#productRows");
  rows.replaceChildren();
  for (const product of products) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.append(makeElement("span", "product-name", product.name));
    const identifiers = [product.sku && `SKU ${product.sku}`, product.barcode && `Barras ${product.barcode}`].filter(Boolean).join(" · ");
    if (identifiers) nameCell.append(makeElement("span", "product-code", identifiers));
    const categoryCell = makeElement("td", "", product.category || "Sin categoría");
    const quantityCell = document.createElement("td");
    quantityCell.append(makeElement("span", "stock-value", formatQuantity(product.quantity)), makeElement("span", "stock-unit", product.unit));
    const status = productStatus(product);
    const statusCell = document.createElement("td");
    statusCell.append(makeElement("span", `status ${status.className}`, status.label));
    const actionsCell = document.createElement("td");
    const actions = makeElement("div", "row-actions");
    const countButton = makeElement("button", "row-action", "Contar");
    countButton.type = "button";
    countButton.dataset.action = "count-product";
    countButton.dataset.id = product.id;
    const editButton = makeElement("button", "row-action", "Editar");
    editButton.type = "button";
    editButton.dataset.action = "edit-product";
    editButton.dataset.id = product.id;
    actions.append(countButton, editButton);
    actionsCell.append(actions);
    row.append(nameCell, categoryCell, quantityCell, statusCell, actionsCell);
    rows.append(row);
  }
  const hasProducts = state.products.length > 0;
  $("#emptyState").hidden = products.length > 0;
  $("#emptyTitle").textContent = hasProducts ? "No hay resultados" : "Tu inventario empieza aquí";
  $("#emptyMessage").textContent = hasProducts ? "Prueba con otro término o cambia el filtro." : "Añade un producto o importa un archivo CSV para comenzar.";
  $("#resultCaption").textContent = hasProducts ? `${products.length} de ${state.products.length} productos` : "Tu catálogo actual";
  $("#productCount").textContent = String(state.products.length);
  $("#lowStockCount").textContent = String(state.products.filter((product) => product.quantity <= product.minStock).length);
  $("#movementCount").textContent = String(state.movements.length);
}

function renderMovements() {
  const rows = $("#movementRows");
  rows.replaceChildren();
  const productById = new Map(state.products.map((product) => [product.id, product]));
  for (const movement of state.movements) {
    const row = document.createElement("tr");
    row.append(makeElement("td", "", formatDate(movement.createdAt, true)));
    row.append(makeElement("td", "", movement.productName || productById.get(movement.productId)?.name || "Producto archivado"));
    row.append(makeElement("td", "", movement.reason));
    const signedDelta = `${movement.delta > 0 ? "+" : ""}${formatQuantity(movement.delta)}`;
    const deltaClass = movement.delta > 0 ? "delta-positive" : movement.delta < 0 ? "delta-negative" : "";
    row.append(makeElement("td", `movement-delta ${deltaClass}`, signedDelta));
    row.append(makeElement("td", "", `${formatQuantity(movement.quantityAfter)} ${movement.unit || ""}`.trim()));
    rows.append(row);
  }
  $("#movementEmpty").hidden = state.movements.length > 0;
}

function render() {
  renderProducts();
  renderMovements();
}

function setView(view) {
  state.view = view;
  const isInventory = view === "inventory";
  $("#inventoryView").hidden = !isInventory;
  $("#movementsView").hidden = isInventory;
  $("#topbarTitle").textContent = isInventory ? "Inventario" : "Historial";
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function findProduct(id) {
  return state.products.find((product) => product.id === id);
}

function openProductDialog(product = null) {
  $("#productError").textContent = "";
  $("#productForm").reset();
  $("#productId").value = product?.id || "";
  $("#productDialogTitle").textContent = product ? "Editar producto" : "Nuevo producto";
  $("#productName").value = product?.name || "";
  $("#productSku").value = product?.sku || "";
  $("#productCategory").value = product?.category || "";
  $("#productBarcode").value = product?.barcode || "";
  $("#productUnit").value = product?.unit || "unidades";
  $("#productMinStock").value = String(product?.minStock ?? 0);
  $("#productDialog").showModal();
  $("#productName").focus();
}

function duplicateField(field, value, exceptId = "") {
  if (!value) return false;
  const normalized = value.toLocaleLowerCase("es");
  return state.products.some((product) => product.id !== exceptId && product[field]?.toLocaleLowerCase("es") === normalized);
}

async function saveProduct(event) {
  event.preventDefault();
  const id = $("#productId").value;
  const current = id ? findProduct(id) : null;
  const product = {
    id: current?.id || makeId(),
    name: normalizeText($("#productName").value),
    sku: normalizeText($("#productSku").value),
    category: normalizeText($("#productCategory").value),
    barcode: normalizeText($("#productBarcode").value),
    unit: normalizeText($("#productUnit").value),
    minStock: asNumber($("#productMinStock").value),
    quantity: current?.quantity ?? 0,
    createdAt: current?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  let error = "";
  if (!product.name || product.name.length > 100) error = "Escribe un nombre de hasta 100 caracteres.";
  else if (!product.unit || product.unit.length > 20) error = "Indica una unidad válida, como piezas o kg.";
  else if (product.minStock === null) error = "El mínimo debe ser un número entre 0 y 1.000.000.000.";
  else if (product.sku.length > 40 || product.barcode.length > 80 || product.category.length > 60) error = "Revisa la longitud de los códigos o la categoría.";
  else if (duplicateField("sku", product.sku, id)) error = "Ese código / SKU ya está asignado a otro producto.";
  else if (duplicateField("barcode", product.barcode, id)) error = "Ese código de barras ya está asignado a otro producto.";
  if (error) {
    $("#productError").textContent = error;
    return;
  }
  try {
    const transaction = state.database.transaction("products", "readwrite");
    const done = transactionComplete(transaction);
    transaction.objectStore("products").put(product);
    await done;
    $("#productDialog").close();
    await refreshData();
    toast(current ? "Producto actualizado." : "Producto añadido.");
  } catch (saveError) {
    reportError(saveError);
  }
}

function openCountDialog(product) {
  $("#countError").textContent = "";
  $("#countProductId").value = product.id;
  $("#countProductName").textContent = product.name;
  $("#currentStock").textContent = `${formatQuantity(product.quantity)} ${product.unit}`;
  $("#countQuantity").value = String(product.quantity);
  $("#countReason").value = "Conteo físico";
  $("#countDialog").showModal();
  $("#countQuantity").focus();
  $("#countQuantity").select();
}

async function saveCount(event) {
  event.preventDefault();
  const id = $("#countProductId").value;
  const counted = asNumber($("#countQuantity").value);
  const reason = normalizeText($("#countReason").value);
  const previous = findProduct(id)?.quantity;
  if (counted === null || !reason || reason.length > 120) {
    $("#countError").textContent = "Indica una cantidad válida y un motivo de hasta 120 caracteres.";
    return;
  }
  try {
    const transaction = state.database.transaction(["products", "movements"], "readwrite");
    const done = transactionComplete(transaction);
    const products = transaction.objectStore("products");
    const request = products.get(id);
    request.onsuccess = () => {
      const product = request.result;
      if (!product) { transaction.abort(); return; }
      const delta = counted - product.quantity;
      if (delta !== 0) {
        const quantityBefore = product.quantity;
        product.quantity = counted;
        product.updatedAt = new Date().toISOString();
        products.put(product);
        transaction.objectStore("movements").add({
          id: makeId(), productId: product.id, productName: product.name, unit: product.unit,
          delta, quantityBefore, quantityAfter: counted, reason, createdAt: new Date().toISOString()
        });
      }
    };
    await done;
    $("#countDialog").close();
    await refreshData();
    toast(previous === counted ? "Conteo revisado; sin cambios." : "Existencias actualizadas.");
  } catch (saveError) {
    reportError(saveError);
  }
}

function detectDelimiter(text) {
  let quoted = false;
  let commas = 0;
  let semicolons = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && text[index + 1] === '"' && quoted) index += 1;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && (character === "\n" || character === "\r")) break;
    else if (!quoted && character === ",") commas += 1;
    else if (!quoted && character === ";") semicolons += 1;
  }
  return semicolons > commas ? ";" : ",";
}

function parseCSV(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"' && cell.length === 0) quoted = true;
    else if (character === delimiter) { row.push(cell); cell = ""; }
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > maximumImportRows + 1) throw new Error(`El archivo supera el límite de ${maximumImportRows} productos.`);
    } else cell += character;
  }
  if (quoted) throw new Error("El archivo CSV contiene comillas sin cerrar.");
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  if (!rows.length) throw new Error("El archivo CSV está vacío.");
  return rows;
}

function fieldIndex(headers, aliases) {
  return headers.findIndex((header) => aliases.includes(normalizedKey(header)));
}

function spreadsheetValue(value) {
  const text = String(value ?? "");
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const safe = typeof value === "number" ? String(value) : spreadsheetValue(value);
  return `"${safe.replace(/"/g, '""')}"`;
}

function saveCsv(filename, rows) {
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportData() {
  if (state.view === "movements") {
    const rows = [["fecha", "producto", "sku", "motivo", "cambio", "existencias", "unidad"]];
    const productById = new Map(state.products.map((product) => [product.id, product]));
    for (const movement of state.movements) {
      const product = productById.get(movement.productId);
      rows.push([movement.createdAt, movement.productName || product?.name || "", product?.sku || "", movement.reason, movement.delta, movement.quantityAfter, movement.unit || ""]);
    }
    saveCsv("historial-inventario.csv", rows);
    return;
  }
  const rows = [["sku", "nombre", "categoria", "codigo_barras", "existencias", "minimo", "unidad"]];
  for (const product of state.products) rows.push([product.sku, product.name, product.category, product.barcode, product.quantity, product.minStock, product.unit]);
  saveCsv("inventario-tienda.csv", rows);
}

function unescapeSpreadsheetPrefix(value) {
  return value.startsWith("'") && /^[=+\-@]/.test(value.slice(1)) ? value.slice(1) : value;
}

function validateCSVRows(rows) {
  const headers = rows[0].map(normalizedKey);
  const indexes = {
    name: fieldIndex(headers, ["nombre", "name", "producto", "product"]),
    sku: fieldIndex(headers, ["sku", "codigo", "referencia", "code"]),
    category: fieldIndex(headers, ["categoria", "category"]),
    barcode: fieldIndex(headers, ["codigobarras", "barcode", "ean"]),
    quantity: fieldIndex(headers, ["existencias", "stock", "cantidad", "quantity"]),
    minStock: fieldIndex(headers, ["minimo", "stockminimo", "minimumstock", "minstock"]),
    unit: fieldIndex(headers, ["unidad", "unit"])
  };
  if (indexes.name < 0) throw new Error("Falta una columna de nombre (nombre o name). Exporta primero una plantilla CSV desde la app.");
  const existingSkus = new Set(state.products.map((product) => product.sku.toLocaleLowerCase("es")).filter(Boolean));
  const existingBarcodes = new Set(state.products.map((product) => product.barcode.toLocaleLowerCase("es")).filter(Boolean));
  const accepted = [];
  const errors = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    const get = (key) => indexes[key] >= 0 ? unescapeSpreadsheetPrefix(normalizeText(values[indexes[key]] || "")) : "";
    const name = get("name");
    const sku = get("sku");
    const barcode = get("barcode");
    const quantityText = get("quantity").replace(",", ".");
    const minText = get("minStock").replace(",", ".");
    const quantity = quantityText ? asNumber(quantityText) : 0;
    const minStock = minText ? asNumber(minText) : 0;
    let issue = "";
    if (values.length !== headers.length) issue = "número de columnas distinto al encabezado";
    else if (!name || name.length > 100) issue = "nombre vacío o demasiado largo";
    else if (sku.length > 40 || barcode.length > 80) issue = "código demasiado largo";
    else if (quantity === null || minStock === null) issue = "cantidad o mínimo no válido";
    else if ((sku && existingSkus.has(sku.toLocaleLowerCase("es"))) || (barcode && existingBarcodes.has(barcode.toLocaleLowerCase("es")))) issue = "SKU o código de barras repetido; no se reemplazó el producto";
    if (issue) {
      if (errors.length < 20) errors.push(`Fila ${rowIndex + 1}: ${issue}.`);
      continue;
    }
    const now = new Date().toISOString();
    const product = {
      id: makeId(), name, sku, barcode, category: get("category").slice(0, 60),
      quantity, minStock, unit: (get("unit") || "unidades").slice(0, 20), createdAt: now, updatedAt: now
    };
    if (sku) existingSkus.add(sku.toLocaleLowerCase("es"));
    if (barcode) existingBarcodes.add(barcode.toLocaleLowerCase("es"));
    accepted.push(product);
  }
  return { accepted, errors, skipped: rows.length - 1 - accepted.length };
}

async function readImportFile(file) {
  if (!file) return;
  if (file.size > maximumImportBytes) throw new Error("El CSV supera el límite de 2 MB.");
  const text = (await file.text()).replace(/^\uFEFF/, "");
  const result = validateCSVRows(parseCSV(text, detectDelimiter(text)));
  state.pendingImport = result.accepted;
  $("#importSummary").textContent = `${result.accepted.length} productos listos para añadir. ${result.skipped} filas omitidas por errores o duplicados.`;
  const list = $("#importErrors");
  list.replaceChildren();
  for (const error of result.errors) list.append(makeElement("li", "", error));
  $("#confirmImport").disabled = result.accepted.length === 0;
  $("#confirmImport").textContent = result.accepted.length ? `Importar ${result.accepted.length}` : "Nada que importar";
  $("#importDialog").showModal();
}

async function commitImport(event) {
  event.preventDefault();
  if (!state.pendingImport.length) return;
  const productsToAdd = state.pendingImport;
  try {
    const transaction = state.database.transaction(["products", "movements"], "readwrite");
    const done = transactionComplete(transaction);
    const productStore = transaction.objectStore("products");
    const movementStore = transaction.objectStore("movements");
    for (const product of productsToAdd) {
      productStore.add(product);
      if (product.quantity > 0) movementStore.add({
        id: makeId(), productId: product.id, productName: product.name, unit: product.unit,
        delta: product.quantity, quantityBefore: 0, quantityAfter: product.quantity,
        reason: "Importación CSV", createdAt: product.createdAt
      });
    }
    await done;
    state.pendingImport = [];
    $("#importDialog").close();
    await refreshData();
    toast(`${productsToAdd.length} productos añadidos.`);
  } catch (importError) {
    reportError(importError);
  }
}

function openScanner(target) {
  state.scanTarget = target;
  $("#scannerCode").value = "";
  $("#scannerMessage").textContent = "Puedes escribir el código si tu navegador no admite lectura con cámara.";
  $("#scannerPlaceholder").hidden = false;
  $("#scannerDialog").showModal();
  $("#scannerCode").focus();
}

function stopCamera() {
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.scanTimer = null;
  if (state.mediaStream) state.mediaStream.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  $("#scannerVideo").srcObject = null;
  $("#scannerPlaceholder").hidden = false;
}

async function startCamera() {
  const message = $("#scannerMessage");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    message.textContent = "La cámara requiere abrir la app en localhost o HTTPS. También puedes escribir el código manualmente.";
    return;
  }
  if (!("BarcodeDetector" in window)) {
    message.textContent = "Este navegador no admite lectura de códigos por cámara. Escribe o pega el código manualmente.";
    return;
  }
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    const supported = formats.filter((format) => ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"].includes(format));
    if (!supported.length) throw new Error("No hay formatos de código compatibles en este navegador.");
    const detector = new window.BarcodeDetector({ formats: supported });
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
    const video = $("#scannerVideo");
    video.srcObject = state.mediaStream;
    await video.play();
    $("#scannerPlaceholder").hidden = true;
    message.textContent = "Apunta la cámara al código de barras.";
    let detecting = false;
    state.scanTimer = setInterval(async () => {
      if (detecting || !video.videoWidth) return;
      detecting = true;
      try {
        const matches = await detector.detect(video);
        if (matches.length) useScannedCode(matches[0].rawValue);
      } catch {
        message.textContent = "No se pudo leer el código. Inténtalo otra vez o escríbelo manualmente.";
      } finally {
        detecting = false;
      }
    }, 350);
  } catch (cameraError) {
    stopCamera();
    message.textContent = cameraError instanceof Error ? cameraError.message : "No se pudo iniciar la cámara. Puedes escribir el código manualmente.";
  }
}

function useScannedCode(value) {
  const code = normalizeText(value).slice(0, 80);
  if (!code) return;
  const target = state.scanTarget;
  if (target?.isConnected) {
    target.value = code;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
  stopCamera();
  $("#scannerDialog").close();
  toast("Código capturado.");
}

function exportData() {
  if (state.view === "movements") {
    const rows = [["fecha", "producto", "sku", "motivo", "cambio", "existencias", "unidad"]];
    const productById = new Map(state.products.map((product) => [product.id, product]));
    for (const movement of state.movements) {
      const product = productById.get(movement.productId);
      rows.push([movement.createdAt, movement.productName || product?.name || "", product?.sku || "", movement.reason, movement.delta, movement.quantityAfter, movement.unit || ""]);
    }
    saveCsv("historial-inventario.csv", rows);
    return;
  }
  const rows = [["sku", "nombre", "categoria", "codigo_barras", "existencias", "minimo", "unidad"]];
  for (const product of state.products) rows.push([product.sku, product.name, product.category, product.barcode, product.quantity, product.minStock, product.unit]);
  saveCsv("inventario-tienda.csv", rows);
}

function saveCsv(filename, rows) {
  const csvCell = (value) => {
    const text = typeof value === "number" ? String(value) : String(value ?? "").replace(/^\s*[=+\-@]/, (match) => `'${match}`);
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function unescapeSpreadsheetPrefix(value) {
  return value.startsWith("'") && /^[=+\-@]/.test(value.slice(1)) ? value.slice(1) : value;
}

function validateCSVRows(rows) {
  const headers = rows[0].map(normalizedKey);
  const indexes = {
    name: fieldIndex(headers, ["nombre", "name", "producto", "product"]),
    sku: fieldIndex(headers, ["sku", "codigo", "referencia", "code"]),
    category: fieldIndex(headers, ["categoria", "category"]),
    barcode: fieldIndex(headers, ["codigobarras", "barcode", "ean"]),
    quantity: fieldIndex(headers, ["existencias", "stock", "cantidad", "quantity"]),
    minStock: fieldIndex(headers, ["minimo", "stockminimo", "minimumstock", "minstock"]),
    unit: fieldIndex(headers, ["unidad", "unit"])
  };
  if (indexes.name < 0) throw new Error("Falta una columna de nombre (nombre o name). Exporta primero una plantilla CSV desde la app.");
  const existingSkus = new Set(state.products.map((product) => product.sku.toLocaleLowerCase("es")).filter(Boolean));
  const existingBarcodes = new Set(state.products.map((product) => product.barcode.toLocaleLowerCase("es")).filter(Boolean));
  const accepted = [];
  const errors = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    const get = (key) => indexes[key] >= 0 ? unescapeSpreadsheetPrefix(normalizeText(values[indexes[key]] || "")) : "";
    const name = get("name");
    const sku = get("sku");
    const barcode = get("barcode");
    const quantityText = get("quantity").replace(",", ".");
    const minText = get("minStock").replace(",", ".");
    const quantity = quantityText ? asNumber(quantityText) : 0;
    const minStock = minText ? asNumber(minText) : 0;
    let issue = "";
    if (values.length !== headers.length) issue = "número de columnas distinto al encabezado";
    else if (!name || name.length > 100) issue = "nombre vacío o demasiado largo";
    else if (sku.length > 40 || barcode.length > 80) issue = "código demasiado largo";
    else if (quantity === null || minStock === null) issue = "cantidad o mínimo no válido";
    else if ((sku && existingSkus.has(sku.toLocaleLowerCase("es"))) || (barcode && existingBarcodes.has(barcode.toLocaleLowerCase("es")))) issue = "SKU o código de barras repetido; no se reemplazó el producto";
    if (issue) {
      if (errors.length < 20) errors.push(`Fila ${rowIndex + 1}: ${issue}.`);
      continue;
    }
    const now = new Date().toISOString();
    const product = {
      id: makeId(), name, sku, barcode, category: get("category").slice(0, 60),
      quantity, minStock, unit: (get("unit") || "unidades").slice(0, 20), createdAt: now, updatedAt: now
    };
    if (sku) existingSkus.add(sku.toLocaleLowerCase("es"));
    if (barcode) existingBarcodes.add(barcode.toLocaleLowerCase("es"));
    accepted.push(product);
  }
  return { accepted, errors, skipped: rows.length - 1 - accepted.length };
}

async function readImportFile(file) {
  if (!file) return;
  if (file.size > maximumImportBytes) throw new Error("El CSV supera el límite de 2 MB.");
  const text = (await file.text()).replace(/^\uFEFF/, "");
  const result = validateCSVRows(parseCSV(text, detectDelimiter(text)));
  state.pendingImport = result.accepted;
  $("#importSummary").textContent = `${result.accepted.length} productos listos para añadir. ${result.skipped} filas omitidas por errores o duplicados.`;
  const list = $("#importErrors");
  list.replaceChildren();
  for (const error of result.errors) list.append(makeElement("li", "", error));
  $("#confirmImport").disabled = result.accepted.length === 0;
  $("#confirmImport").textContent = result.accepted.length ? `Importar ${result.accepted.length}` : "Nada que importar";
  $("#importDialog").showModal();
}

async function commitImport(event) {
  event.preventDefault();
  if (!state.pendingImport.length) return;
  const productsToAdd = state.pendingImport;
  try {
    const transaction = state.database.transaction(["products", "movements"], "readwrite");
    const done = transactionComplete(transaction);
    const productStore = transaction.objectStore("products");
    const movementStore = transaction.objectStore("movements");
    for (const product of productsToAdd) {
      productStore.add(product);
      if (product.quantity > 0) movementStore.add({
        id: makeId(), productId: product.id, productName: product.name, unit: product.unit,
        delta: product.quantity, quantityBefore: 0, quantityAfter: product.quantity,
        reason: "Importación CSV", createdAt: product.createdAt
      });
    }
    await done;
    state.pendingImport = [];
    $("#importDialog").close();
    await refreshData();
    toast(`${productsToAdd.length} productos añadidos.`);
  } catch (importError) {
    reportError(importError);
  }
}

function openScanner(target) {
  state.scanTarget = target;
  $("#scannerCode").value = "";
  $("#scannerMessage").textContent = "Puedes escribir el código si tu navegador no admite lectura con cámara.";
  $("#scannerPlaceholder").hidden = false;
  $("#scannerDialog").showModal();
  $("#scannerCode").focus();
}

function stopCamera() {
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.scanTimer = null;
  if (state.mediaStream) state.mediaStream.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
  $("#scannerVideo").srcObject = null;
  $("#scannerPlaceholder").hidden = false;
}

async function startCamera() {
  const message = $("#scannerMessage");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    message.textContent = "La cámara requiere abrir la app en localhost o HTTPS. También puedes escribir el código manualmente.";
    return;
  }
  if (!("BarcodeDetector" in window)) {
    message.textContent = "Este navegador no admite lectura de códigos por cámara. Escribe o pega el código manualmente.";
    return;
  }
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    const supported = formats.filter((format) => ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"].includes(format));
    if (!supported.length) throw new Error("No hay formatos de código compatibles en este navegador.");
    const detector = new window.BarcodeDetector({ formats: supported });
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
    const video = $("#scannerVideo");
    video.srcObject = state.mediaStream;
    await video.play();
    $("#scannerPlaceholder").hidden = true;
    message.textContent = "Apunta la cámara al código de barras.";
    let detecting = false;
    state.scanTimer = setInterval(async () => {
      if (detecting || !video.videoWidth) return;
      detecting = true;
      try {
        const matches = await detector.detect(video);
        if (matches.length) useScannedCode(matches[0].rawValue);
      } catch {
        message.textContent = "No se pudo leer el código. Inténtalo otra vez o escríbelo manualmente.";
      } finally {
        detecting = false;
      }
    }, 350);
  } catch (cameraError) {
    stopCamera();
    message.textContent = cameraError instanceof Error ? cameraError.message : "No se pudo iniciar la cámara. Puedes escribir el código manualmente.";
  }
}

function useScannedCode(value) {
  const code = normalizeText(value).slice(0, 80);
  if (!code) return;
  const target = state.scanTarget;
  if (target?.isConnected) {
    target.value = code;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
  stopCamera();
  $("#scannerDialog").close();
  toast("Código capturado.");
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === "add-product") openProductDialog();
    else if (action === "edit-product") { const product = findProduct(id); if (product) openProductDialog(product); }
    else if (action === "count-product") { const product = findProduct(id); if (product) openCountDialog(product); }
    else if (action === "import") { $("#csvFile").value = ""; $("#csvFile").click(); }
    else if (action === "export") exportData();
    else if (action === "scan") openScanner($("#searchInput"));
    else if (action === "start-camera") startCamera();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-close]");
    if (button) $(`#${button.dataset.close}`).close();
  });
  $("#searchInput").addEventListener("input", renderProducts);
  $("#stockFilter").addEventListener("change", renderProducts);
  $("#productForm").addEventListener("submit", saveProduct);
  $("#countForm").addEventListener("submit", saveCount);
  $("#importForm").addEventListener("submit", commitImport);
  $("#csvFile").addEventListener("change", async (event) => {
    try { await readImportFile(event.target.files[0]); }
    catch (error) { reportError(error); }
  });
  $("#scannerForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = normalizeText($("#scannerCode").value);
    if (code) useScannedCode(code);
    else $("#scannerMessage").textContent = "Escribe un código antes de continuar.";
  });
  $("#scanBarcodeField").addEventListener("click", () => openScanner($("#productBarcode")));
  $("#scannerDialog").addEventListener("close", stopCamera);
  $("#importDialog").addEventListener("close", () => { state.pendingImport = []; });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") stopCamera(); });
}

async function initialize() {
  $("#todayLabel").textContent = new Intl.DateTimeFormat("es", { dateStyle: "medium" }).format(new Date());
  bindEvents();
  try {
    state.database = await openDatabase();
    await refreshData();
  } catch (error) {
    document.querySelector("main").replaceChildren(makeElement("p", "privacy-note", `No se pudo iniciar el almacenamiento local. ${error.message}`));
    reportError(error);
  }
}

initialize();