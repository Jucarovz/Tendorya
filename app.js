"use strict";

const databaseName = "tienda-inventario-local";
const databaseVersion = 2;
const maximumImportBytes = 5 * 1024 * 1024;
const maximumImportRows = 5000;
const currencyByRegion = {
  AF: "AFN", AL: "ALL", AD: "EUR", AM: "AMD", AR: "ARS", AT: "EUR", AU: "AUD",
  AZ: "AZN", BH: "BHD", BD: "BDT", BY: "BYN", BE: "EUR", BA: "BAM", BO: "BOB",
  BR: "BRL", BN: "BND", BG: "EUR", BT: "BTN", KH: "KHR", CA: "CAD", CL: "CLP",
  CN: "CNY", CO: "COP", CR: "CRC", HR: "EUR", CY: "EUR", CZ: "CZK", DK: "DKK",
  DO: "DOP", EC: "USD", SV: "USD", EE: "EUR", FI: "EUR", FR: "EUR", GE: "GEL",
  DE: "EUR", GR: "EUR", GT: "GTQ", HN: "HNL", HK: "HKD", HU: "HUF", IS: "ISK",
  IN: "INR", ID: "IDR", IR: "IRR", IQ: "IQD", IE: "EUR", IL: "ILS", IT: "EUR",
  JP: "JPY", JO: "JOD", KZ: "KZT", KP: "KPW", KR: "KRW", KW: "KWD", KG: "KGS",
  LA: "LAK", LV: "EUR", LB: "LBP", LI: "CHF", LT: "EUR", LU: "EUR", MO: "MOP",
  MY: "MYR", MV: "MVR", MT: "EUR", MX: "MXN", MD: "MDL", MC: "EUR", MN: "MNT",
  ME: "EUR", MM: "MMK", NP: "NPR", NL: "EUR", NZ: "NZD", NI: "NIO", NO: "NOK",
  OM: "OMR", PK: "PKR", PS: "ILS", PA: "PAB", PY: "PYG", PE: "PEN", PH: "PHP",
  PL: "PLN", PT: "EUR", QA: "QAR", MK: "MKD", RO: "RON", RU: "RUB", SM: "EUR",
  SA: "SAR", RS: "RSD", SG: "SGD", SK: "EUR", SI: "EUR", ES: "EUR", LK: "LKR",
  SE: "SEK", CH: "CHF", SY: "SYP", TW: "TWD", TJ: "TJS", TH: "THB", TL: "USD",
  TN: "TND", TR: "TRY", TM: "TMT", UA: "UAH", AE: "AED", GB: "GBP", US: "USD",
  UY: "UYU", UZ: "UZS", VA: "EUR", VE: "VES", VN: "VND", YE: "YER"
};
const $ = (selector) => document.querySelector(selector);
const state = { database: null, products: [], movements: [], cashMovements: [], monthlyMovements: [], currency: "USD", view: "inventory", pendingImport: [], scanTarget: null, mediaStream: null, scanTimer: null, toastTimer: null };

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
      if (!database.objectStoreNames.contains("cashMovements")) {
        const cashMovements = database.createObjectStore("cashMovements", { keyPath: "id" });
        cashMovements.createIndex("createdAt", "createdAt", { unique: false });
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

function formatMoney(value, currency = state.currency) {
  return new Intl.NumberFormat(navigator.language || "es", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value || 0);
}

function formatMoneyGroups(entries) {
  const totals = new Map();
  for (const [amount, currency] of entries) {
    const key = currency || state.currency;
    totals.set(key, (totals.get(key) || 0) + amount);
  }
  return [...totals].map(([currency, amount]) => formatMoney(amount, currency)).join(" · ") || formatMoney(0);
}

function initializeCurrency() {
  let savedCurrency = "";
  let savedCountrySelection = "";
  try {
    savedCurrency = localStorage.getItem("tendoryaCurrency") || "";
    savedCountrySelection = localStorage.getItem("tendoryaCountrySelection") || "";
  } catch {
    savedCurrency = "";
    savedCountrySelection = "";
  }
  const region = (navigator.language || "").split("-").pop().toUpperCase();
  const suggestedCurrency = currencyByRegion[region] || "USD";
  const select = $("#currencySelect");
  const options = [...select.options];
  const savedOption = options.find((option) => option.value === savedCurrency && option.textContent.trim() === savedCountrySelection);
  const suggestedOption = options.find((option) => option.value === suggestedCurrency && option.textContent.trim().startsWith(getRegionLabel(region)));
  state.currency = options.some((option) => option.value === savedCurrency) ? savedCurrency : suggestedCurrency;
  if (savedOption) select.selectedIndex = options.indexOf(savedOption);
  else if (suggestedOption) select.selectedIndex = options.indexOf(suggestedOption);
  else select.value = state.currency;
  updateCurrencyLabels();
}

function getRegionLabel(region) {
  try {
    return new Intl.DisplayNames(["es"], { type: "region" }).of(region) || "";
  } catch {
    return "";
  }
}

function updateCurrencyLabels() {
  document.querySelectorAll(".currency-code").forEach((label) => {
    label.textContent = state.currency;
  });
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
  const [products, movements, cashMovements] = await Promise.all([
    readAll("products"),
    readAll("movements"),
    readAll("cashMovements")
  ]);
  state.products = products.sort((left, right) => left.name.localeCompare(right.name, "es"));
  state.movements = movements.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  state.cashMovements = cashMovements.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
    const currency = product.currency || state.currency;
    const prices = `${formatMoney(product.purchasePrice, currency)}/${product.unit} costo · ${formatMoney(product.salePrice, currency)}/${product.unit} venta`;
    nameCell.append(makeElement("span", "product-code", [identifiers, prices].filter(Boolean).join(" · ")));
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
    const movementButton = makeElement("button", "row-action", "Movimiento");
    movementButton.type = "button";
    movementButton.dataset.action = "stock-movement";
    movementButton.dataset.id = product.id;
    actions.append(countButton, movementButton, editButton);
    actionsCell.append(actions);
    row.append(nameCell, categoryCell, quantityCell, statusCell, actionsCell);
    rows.append(row);
  }
  const hasProducts = state.products.length > 0;
  $("#emptyState").hidden = products.length > 0;
  $("#emptyTitle").textContent = hasProducts ? "No hay resultados" : "Tu inventario empieza aquí";
  $("#emptyMessage").textContent = hasProducts ? "Prueba con otro término o cambia el filtro." : "Añade un producto o importa un archivo CSV o Excel para comenzar.";
  $("#resultCaption").textContent = hasProducts ? `${products.length} de ${state.products.length} productos` : "Tu catálogo actual";
  $("#productCount").textContent = String(state.products.length);
  $("#lowStockCount").textContent = String(state.products.filter((product) => product.quantity <= product.minStock).length);
  $("#movementCount").textContent = String(state.movements.length);
  $("#stockValue").textContent = formatMoneyGroups(state.products.map((product) => [product.quantity * (product.purchasePrice || 0), product.currency]));
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

function monthKey(dateValue) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  const label = new Intl.DateTimeFormat("es", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
  return label.charAt(0).toLocaleUpperCase("es") + label.slice(1);
}

function renderMonthlyMovements() {
  const select = $("#monthlyMonth");
  const currentMonth = monthKey(new Date());
  const previousSelection = select.value;
  const months = [...new Set([
    currentMonth,
    ...state.movements.map((movement) => monthKey(movement.createdAt)),
    ...state.cashMovements.map((movement) => monthKey(movement.createdAt))
  ].filter(Boolean))].sort().reverse();
  select.replaceChildren(...months.map((month) => {
    const option = document.createElement("option");
    option.value = month;
    option.textContent = monthLabel(month);
    return option;
  }));
  const selectedMonth = months.includes(previousSelection) ? previousSelection : months[0];
  select.value = selectedMonth;

  state.monthlyMovements = [
    ...state.movements.filter((movement) => monthKey(movement.createdAt) === selectedMonth),
    ...state.cashMovements.filter((movement) => monthKey(movement.createdAt) === selectedMonth)
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const financialMovements = state.monthlyMovements.filter((movement) => ["purchase", "sale", "entry", "exit"].includes(movement.type));
  const entries = financialMovements.filter((movement) => movement.type === "sale" || movement.type === "entry");
  const exits = financialMovements.filter((movement) => movement.type === "purchase" || movement.type === "exit");
  const entryAmounts = entries.map((movement) => [movement.amount || 0, movement.currency]);
  const exitAmounts = exits.map((movement) => [movement.amount || 0, movement.currency]);
  const balanceAmounts = financialMovements.map((movement) => [
    ["sale", "entry"].includes(movement.type) ? movement.amount || 0 : -(movement.amount || 0),
    movement.currency
  ]);
  $("#monthlyEntries").textContent = formatMoneyGroups(entryAmounts);
  $("#monthlyExits").textContent = formatMoneyGroups(exitAmounts);
  $("#monthlyBalance").textContent = formatMoneyGroups(balanceAmounts);
  $("#monthlyStockValue").textContent = formatMoneyGroups(state.products.map((product) => [product.quantity * (product.purchasePrice || 0), product.currency]));
  $("#monthlyEntryRecords").textContent = `${entries.length} ${entries.length === 1 ? "movimiento" : "movimientos"}`;
  $("#monthlyExitRecords").textContent = `${exits.length} ${exits.length === 1 ? "movimiento" : "movimientos"}`;
  $("#monthlyDetailsCaption").textContent = monthLabel(selectedMonth);

  const rows = $("#monthlyRows");
  rows.replaceChildren();
  const productById = new Map(state.products.map((product) => [product.id, product]));
  for (const movement of state.monthlyMovements) {
    const typeLabels = { purchase: "Compra de stock", sale: "Venta de stock", entry: "Entrada", exit: "Salida", adjustment: "Ajuste" };
    const typeClass = ["sale", "entry"].includes(movement.type) ? "monthly-type-entry" : ["purchase", "exit"].includes(movement.type) ? "monthly-type-exit" : "monthly-type-adjustment";
    const isCashMovement = movement.type === "entry" || movement.type === "exit";
    const enteredQuantity = movement.enteredQuantity ?? Math.abs(movement.delta);
    const enteredUnit = movement.enteredUnit || movement.unit || "";
    const row = document.createElement("tr");
    row.append(makeElement("td", "", formatDate(movement.createdAt, true)));
    row.append(makeElement("td", "", isCashMovement ? movement.name : movement.productName || productById.get(movement.productId)?.name || "Producto archivado"));
    row.append(makeElement("td", "", ""));
    row.lastElementChild.append(makeElement("span", `monthly-type ${typeClass}`, typeLabels[movement.type] || "Ajuste"));
    row.append(makeElement("td", "", isCashMovement ? "—" : `${formatQuantity(enteredQuantity)} ${enteredUnit}`.trim()));
    row.append(makeElement("td", "", !isCashMovement && Number.isFinite(movement.unitPrice) ? formatMoney(movement.unitPrice, movement.currency || state.currency) : "—"));
    row.append(makeElement("td", "", Number.isFinite(movement.amount) ? formatMoney(movement.amount, movement.currency || state.currency) : "—"));
    row.append(makeElement("td", "", movement.reason || (isCashMovement ? "Movimiento de dinero" : "Ajuste de existencias")));
    rows.append(row);
  }
  $("#monthlyEmpty").hidden = state.monthlyMovements.length > 0;
}

function openCashMovementDialog() {
  $("#cashMovementForm").reset();
  $("#cashMovementType").value = "entry";
  $("#cashMovementError").textContent = "";
  $("#cashMovementDialog").showModal();
  $("#cashMovementName").focus();
}

async function saveCashMovement(event) {
  event.preventDefault();
  const name = normalizeText($("#cashMovementName").value);
  const type = $("#cashMovementType").value;
  const amount = asNumber($("#cashMovementAmount").value);
  const error = $("#cashMovementError");
  if (!name || name.length > 100) {
    error.textContent = "Escribe un nombre o concepto de hasta 100 caracteres.";
    return;
  }
  if (amount === null || amount <= 0) {
    error.textContent = "El valor debe ser mayor que cero.";
    return;
  }
  try {
    const transaction = state.database.transaction("cashMovements", "readwrite");
    const done = transactionComplete(transaction);
    transaction.objectStore("cashMovements").add({
      id: makeId(), name, type, amount, currency: state.currency,
      createdAt: new Date().toISOString()
    });
    await done;
    $("#cashMovementDialog").close();
    await refreshData();
    toast(type === "entry" ? "Entrada registrada." : "Salida registrada.");
  } catch (saveError) {
    reportError(saveError);
  }
}

function generateInvoice() {
  const financialMovements = state.monthlyMovements.filter((movement) => ["purchase", "sale", "entry", "exit"].includes(movement.type));
  const entries = financialMovements.filter((movement) => movement.type === "sale" || movement.type === "entry");
  const exits = financialMovements.filter((movement) => movement.type === "purchase" || movement.type === "exit");
  const entryAmounts = entries.map((movement) => [movement.amount || 0, movement.currency]);
  const exitAmounts = exits.map((movement) => [movement.amount || 0, movement.currency]);
  const balanceAmounts = financialMovements.map((movement) => [
    ["sale", "entry"].includes(movement.type) ? movement.amount || 0 : -(movement.amount || 0),
    movement.currency
  ]);
  const productById = new Map(state.products.map((product) => [product.id, product]));
  const rows = $("#invoiceRows");
  rows.replaceChildren();

  for (const movement of financialMovements) {
    const isCashMovement = movement.type === "entry" || movement.type === "exit";
    const labels = { purchase: "Salida · compra", sale: "Entrada · venta", entry: "Entrada", exit: "Salida" };
    const concept = isCashMovement ? movement.name : movement.productName || productById.get(movement.productId)?.name || "Producto archivado";
    const currency = movement.currency || state.currency;
    const row = document.createElement("tr");
    row.append(makeElement("td", "", formatDate(movement.createdAt)));
    row.append(makeElement("td", "", concept));
    row.append(makeElement("td", "", labels[movement.type]));
    row.append(makeElement("td", "", formatMoney(movement.amount || 0, currency)));
    rows.append(row);
  }

  $("#invoiceMonth").textContent = monthLabel($("#monthlyMonth").value);
  $("#invoiceEntries").textContent = formatMoneyGroups(entryAmounts);
  $("#invoiceExits").textContent = formatMoneyGroups(exitAmounts);
  $("#invoiceBalance").textContent = formatMoneyGroups(balanceAmounts);
  $("#invoiceStockValue").textContent = formatMoneyGroups(state.products.map((product) => [product.quantity * (product.purchasePrice || 0), product.currency]));
  $("#invoiceDialog").showModal();
}

function render() {
  renderProducts();
  renderMovements();
  renderMonthlyMovements();
}

function setView(view) {
  state.view = view;
  $("#inventoryView").hidden = view !== "inventory";
  $("#movementsView").hidden = view !== "movements";
  $("#monthlyView").hidden = view !== "monthly";
  $("#topbarTitle").textContent = view === "inventory" ? "Inventario" : view === "monthly" ? "Compras y ventas" : "Historial";
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
  $("#productPurchasePrice").value = String(product?.purchasePrice ?? 0);
  $("#productSalePrice").value = String(product?.salePrice ?? 0);
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
    purchasePrice: asNumber($("#productPurchasePrice").value),
    salePrice: asNumber($("#productSalePrice").value),
    currency: current?.currency || state.currency,
    quantity: current?.quantity ?? 0,
    createdAt: current?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  let error = "";
  if (!product.name || product.name.length > 100) error = "Escribe un nombre de hasta 100 caracteres.";
  else if (!product.unit || product.unit.length > 20) error = "Indica una unidad válida, como piezas o kg.";
  else if (product.minStock === null) error = "El mínimo debe ser un número entre 0 y 1.000.000.000.";
  else if (product.purchasePrice === null || product.salePrice === null) error = "Los precios deben estar entre 0 y 1.000.000.000.";
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
          delta, quantityBefore, quantityAfter: counted, reason,
          createdAt: new Date().toISOString(), type: "adjustment"
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

function openStockMovement(product) {
  $("#stockMovementError").textContent = "";
  $("#stockMovementProductId").value = product.id;
  $("#stockMovementProduct").textContent = product.name;
  $("#stockMovementCurrent").textContent = `${formatQuantity(product.quantity)} ${product.unit}`;
  $("#stockMovementType").value = "purchase";
  $("#stockMovementQuantity").value = "1";
  $("#stockMovementNote").value = "";
  updateStockMovementPrice();
  $("#stockMovementDialog").showModal();
  $("#stockMovementQuantity").focus();
  $("#stockMovementQuantity").select();
}

function updateStockMovementPrice() {
  const product = findProduct($("#stockMovementProductId").value);
  if (!product) return;
  const isSale = $("#stockMovementType").value === "sale";
  const price = isSale ? product.salePrice : product.purchasePrice;
  $("#stockMovementPriceUnit").textContent = product.unit;
  $("#stockMovementUnitPrice").value = String(price || 0);
}

async function saveStockMovement(event) {
  event.preventDefault();
  const productId = $("#stockMovementProductId").value;
  const type = $("#stockMovementType").value;
  const quantity = asNumber($("#stockMovementQuantity").value);
  const unitPrice = asNumber($("#stockMovementUnitPrice").value);
  const product = findProduct(productId);
  const errorElement = $("#stockMovementError");
  if (!product) {
    errorElement.textContent = "No se encontró el producto seleccionado.";
    return;
  }
  if (quantity === null || quantity <= 0 || unitPrice === null) {
    errorElement.textContent = "Indica una cantidad mayor que cero y un precio válido.";
    return;
  }
  if (type === "sale" && quantity > product.quantity) {
    errorElement.textContent = "No hay existencias suficientes para registrar esta venta.";
    return;
  }

  let insufficientStock = false;
  try {
    const transaction = state.database.transaction(["products", "movements"], "readwrite");
    const done = transactionComplete(transaction);
    const products = transaction.objectStore("products");
    const request = products.get(productId);
    request.onsuccess = () => {
      const currentProduct = request.result;
      if (!currentProduct) {
        transaction.abort();
        return;
      }
      if (type === "sale" && quantity > currentProduct.quantity) {
        insufficientStock = true;
        transaction.abort();
        return;
      }
      const delta = type === "purchase" ? quantity : -quantity;
      const quantityBefore = currentProduct.quantity;
      const quantityAfter = quantityBefore + delta;
      const createdAt = new Date().toISOString();
      currentProduct.quantity = quantityAfter;
      if (type === "purchase") {
        const previousStockValue = quantityBefore * (currentProduct.purchasePrice || 0);
        currentProduct.purchasePrice = (previousStockValue + quantity * unitPrice) / quantityAfter;
      }
      currentProduct.updatedAt = createdAt;
      products.put(currentProduct);
      transaction.objectStore("movements").add({
        id: makeId(), productId: currentProduct.id, productName: currentProduct.name,
        unit: currentProduct.unit, type, delta, quantityBefore, quantityAfter,
        enteredQuantity: quantity, enteredUnit: currentProduct.unit,
        unitPrice, amount: quantity * unitPrice, currency: currentProduct.currency || state.currency,
        reason: normalizeText($("#stockMovementNote").value) || (type === "purchase" ? "Compra" : "Venta"),
        createdAt
      });
    };
    await done;
    $("#stockMovementDialog").close();
    await refreshData();
    toast(type === "purchase" ? "Compra registrada." : "Venta registrada.");
  } catch (movementError) {
    if (insufficientStock) {
      errorElement.textContent = "No hay existencias suficientes para registrar esta venta.";
      return;
    }
    reportError(movementError);
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

function parseExcelFile(buffer) {
  if (!window.XLSX) throw new Error("No se pudo cargar el lector de Excel. Recarga la página e inténtalo otra vez.");
  const workbook = window.XLSX.read(buffer, {
    type: "array",
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false
  });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error("El archivo de Excel no contiene hojas.");
  const rows = window.XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false
  });
  if (rows.length > maximumImportRows + 1) {
    throw new Error(`El archivo supera el límite de ${maximumImportRows} productos.`);
  }
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

function saveExcel(filename, rows, sheetName) {
  if (!window.XLSX) {
    toast("No se pudo cargar el exportador de Excel. Recarga la página e inténtalo otra vez.");
    return;
  }
  const safeRows = rows.map((row) => row.map((value) => typeof value === "string" ? spreadsheetValue(value) : value));
  const workbook = window.XLSX.utils.book_new();
  const worksheet = window.XLSX.utils.aoa_to_sheet(safeRows);
  window.XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  window.XLSX.writeFile(workbook, filename, { bookType: "xlsx", compression: true });
}

function exportData() {
  if (state.view === "movements" || state.view === "monthly") {
    const rows = [["fecha", "concepto", "sku", "tipo", "motivo", "cantidad", "unidad", "cambio_stock", "existencias", "precio_unitario", "importe", "moneda"]];
    const productById = new Map(state.products.map((product) => [product.id, product]));
    const movements = state.view === "monthly" ? state.monthlyMovements : state.movements;
    for (const movement of movements) {
      const product = productById.get(movement.productId);
      const typeLabels = { purchase: "Compra de stock", sale: "Venta de stock", entry: "Entrada", exit: "Salida", adjustment: "Ajuste" };
      const isCashMovement = movement.type === "entry" || movement.type === "exit";
      rows.push([
        movement.createdAt, isCashMovement ? movement.name : movement.productName || product?.name || "", product?.sku || "",
        typeLabels[movement.type] || "Ajuste", movement.reason || "", isCashMovement ? "" : movement.enteredQuantity ?? Math.abs(movement.delta),
        isCashMovement ? "" : movement.enteredUnit || movement.unit || "", movement.delta ?? "", movement.quantityAfter ?? "", movement.unitPrice ?? "",
        movement.amount ?? "", movement.currency || state.currency
      ]);
    }
    const filename = state.view === "monthly" ? `entradas-salidas-${$("#monthlyMonth").value}.csv` : "historial-inventario.csv";
    saveCsv(filename, rows);
    return;
  }
  const rows = [["sku", "nombre", "categoria", "codigo_barras", "existencias", "minimo", "unidad", "costo_compra", "precio_venta", "moneda"]];
  for (const product of state.products) {
    rows.push([product.sku, product.name, product.category, product.barcode, product.quantity, product.minStock, product.unit, product.purchasePrice || 0, product.salePrice || 0, product.currency || state.currency]);
  }
  saveCsv("inventario-tienda.csv", rows);
}

function exportExcel() {
  if (state.view === "movements" || state.view === "monthly") {
    const rows = [["fecha", "concepto", "sku", "tipo", "motivo", "cantidad", "unidad", "cambio_stock", "existencias", "precio_unitario", "importe", "moneda"]];
    const productById = new Map(state.products.map((product) => [product.id, product]));
    const movements = state.view === "monthly" ? state.monthlyMovements : state.movements;
    for (const movement of movements) {
      const product = productById.get(movement.productId);
      const typeLabels = { purchase: "Compra de stock", sale: "Venta de stock", entry: "Entrada", exit: "Salida", adjustment: "Ajuste" };
      const isCashMovement = movement.type === "entry" || movement.type === "exit";
      rows.push([
        movement.createdAt, isCashMovement ? movement.name : movement.productName || product?.name || "", product?.sku || "",
        typeLabels[movement.type] || "Ajuste", movement.reason || "", isCashMovement ? "" : movement.enteredQuantity ?? Math.abs(movement.delta),
        isCashMovement ? "" : movement.enteredUnit || movement.unit || "", movement.delta ?? "", movement.quantityAfter ?? "", movement.unitPrice ?? "",
        movement.amount ?? "", movement.currency || state.currency
      ]);
    }
    const filename = state.view === "monthly" ? `compras-ventas-${$("#monthlyMonth").value}.xlsx` : "historial-inventario.xlsx";
    saveExcel(filename, rows, "Movimientos");
    return;
  }
  const rows = [["sku", "nombre", "categoria", "codigo_barras", "existencias", "minimo", "unidad", "costo_compra", "precio_venta", "moneda"]];
  for (const product of state.products) {
    rows.push([product.sku, product.name, product.category, product.barcode, product.quantity, product.minStock, product.unit, product.purchasePrice || 0, product.salePrice || 0, product.currency || state.currency]);
  }
  saveExcel("inventario-tienda.xlsx", rows, "Inventario");
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
    unit: fieldIndex(headers, ["unidad", "unit"]),
    unitsPerPackage: fieldIndex(headers, ["unidadesporpresentacion", "unidadesporpaquete", "unidadesporempaque", "unitsperpackage", "packsize"]),
    packagePrice: fieldIndex(headers, ["costoporpresentacion", "costoporpaquete", "costoporempaque", "costoempaque", "packageprice"]),
    purchasePrice: fieldIndex(headers, ["costocompra", "costocompraunitario", "costounitario", "preciocompra", "purchaseprice", "cost"]),
    salePrice: fieldIndex(headers, ["precioventa", "precioventaunitario", "saleprice", "sellingprice"]),
    currency: fieldIndex(headers, ["moneda", "currency"])
  };
  if (indexes.name < 0) throw new Error("Falta una columna de nombre (nombre o name). Exporta primero una plantilla CSV o Excel desde la app.");
  const existingSkus = new Set(state.products.map((product) => product.sku.toLocaleLowerCase("es")).filter(Boolean));
  const existingBarcodes = new Set(state.products.map((product) => product.barcode.toLocaleLowerCase("es")).filter(Boolean));
  const accepted = [];
  const errors = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    const get = (key) => indexes[key] >= 0 ? unescapeSpreadsheetPrefix(normalizeText(values[indexes[key]] ?? "")) : "";
    const name = get("name");
    const sku = get("sku");
    const barcode = get("barcode");
    const quantityText = get("quantity").replace(",", ".");
    const minText = get("minStock").replace(",", ".");
    const unitsPerPackageText = get("unitsPerPackage").replace(",", ".");
    const packagePriceText = get("packagePrice").replace(",", ".");
    const purchasePriceText = get("purchasePrice").replace(",", ".");
    const salePriceText = get("salePrice").replace(",", ".");
    const currency = get("currency").toUpperCase();
    const validCurrencies = new Set([...$("#currencySelect").options].map((option) => option.value));
    const quantity = quantityText ? asNumber(quantityText) : 0;
    const minStock = minText ? asNumber(minText) : 0;
    const unitsPerPackage = unitsPerPackageText ? asNumber(unitsPerPackageText) : 1;
    const packagePrice = packagePriceText ? asNumber(packagePriceText) : null;
    const purchasePrice = purchasePriceText
      ? asNumber(purchasePriceText)
      : packagePrice !== null ? packagePrice / (unitsPerPackage || 1) : 0;
    const salePrice = salePriceText ? asNumber(salePriceText) : 0;
    let issue = "";
    if (values.length !== headers.length) issue = "número de columnas distinto al encabezado";
    else if (!name || name.length > 100) issue = "nombre vacío o demasiado largo";
    else if (sku.length > 40 || barcode.length > 80) issue = "código demasiado largo";
    else if (unitsPerPackage === null || unitsPerPackage < 1 || !Number.isInteger(unitsPerPackage)) issue = "unidades por empaque no válido";
    else if (quantity === null || minStock === null || purchasePrice === null || salePrice === null || (packagePriceText && packagePrice === null)) issue = "cantidad, precio o mínimo no válido";
    else if ((sku && existingSkus.has(sku.toLocaleLowerCase("es"))) || (barcode && existingBarcodes.has(barcode.toLocaleLowerCase("es")))) issue = "SKU o código de barras repetido; no se reemplazó el producto";
    if (issue) {
      if (errors.length < 20) errors.push(`Fila ${rowIndex + 1}: ${issue}.`);
      continue;
    }
    const now = new Date().toISOString();
    const product = {
      id: makeId(), name, sku, barcode, category: get("category").slice(0, 60),
      quantity, minStock, purchasePrice, salePrice,
      currency: validCurrencies.has(currency) ? currency : state.currency,
      unit: (get("unit") || "unidades").slice(0, 20), createdAt: now, updatedAt: now
    };
    if (sku) existingSkus.add(sku.toLocaleLowerCase("es"));
    if (barcode) existingBarcodes.add(barcode.toLocaleLowerCase("es"));
    accepted.push(product);
  }
  return { accepted, errors, skipped: rows.length - 1 - accepted.length };
}

async function readImportFile(file) {
  if (!file) return;
  if (file.size > maximumImportBytes) throw new Error("El archivo supera el límite de 5 MB.");
  const extension = file.name.split(".").pop().toLowerCase();
  let rows;
  if (extension === "xlsx" || extension === "xls") {
    rows = parseExcelFile(await file.arrayBuffer());
  } else if (extension === "csv") {
    const text = (await file.text()).replace(/^\uFEFF/, "");
    rows = parseCSV(text, detectDelimiter(text));
  } else {
    throw new Error("Selecciona un archivo CSV, XLS o XLSX.");
  }
  const result = validateCSVRows(rows);
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
        type: "adjustment", reason: "Importación CSV", createdAt: product.createdAt
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
    else if (action === "stock-movement") { const product = findProduct(id); if (product) openStockMovement(product); }
    else if (action === "add-cash-movement") openCashMovementDialog();
    else if (action === "generate-invoice") generateInvoice();
    else if (action === "print-invoice") window.print();
    else if (action === "import") { $("#csvFile").value = ""; $("#csvFile").click(); }
    else if (action === "export") exportData();
    else if (action === "export-excel") exportExcel();
    else if (action === "scan") openScanner($("#searchInput"));
    else if (action === "start-camera") startCamera();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-close]");
    if (button) $(`#${button.dataset.close}`).close();
  });
  $("#searchInput").addEventListener("input", renderProducts);
  $("#stockFilter").addEventListener("change", renderProducts);
  $("#monthlyMonth").addEventListener("change", renderMonthlyMovements);
  $("#productForm").addEventListener("submit", saveProduct);
  $("#countForm").addEventListener("submit", saveCount);
  $("#stockMovementForm").addEventListener("submit", saveStockMovement);
  $("#cashMovementForm").addEventListener("submit", saveCashMovement);
  $("#stockMovementType").addEventListener("change", updateStockMovementPrice);
  $("#importForm").addEventListener("submit", commitImport);
  $("#currencySelect").addEventListener("change", () => {
    state.currency = $("#currencySelect").value;
    try {
      localStorage.setItem("tendoryaCurrency", state.currency);
      localStorage.setItem("tendoryaCountrySelection", $("#currencySelect").selectedOptions[0].textContent.trim());
    } catch {
      toast("Moneda cambiada; no se pudo guardar la preferencia en este navegador.");
    }
    updateCurrencyLabels();
    render();
  });
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
  initializeCurrency();
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