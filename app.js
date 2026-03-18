const R2_PUBLIC_BASE_URL = "https://pub-3c8675af56de45118d7bb05bd26b0d00.r2.dev";
const API_BASE_URL = "https://script.google.com/macros/s/AKfycbzFgWZjdZTMlK0KctlX0g5dWF7Vq3kSEWJgMEekZMwitkFuIYvlJb9BK_ECj1G78Q6qOw/exec";
const DIRECTORY_API_BASE_URL = "";

const DATA_MAP = {
  tainguyen: "Tainguyen",
  phanmem: "Phanmem",
  jsx: "JSXPhotoshop",
  panel: "Panel",
  video: "ProjectVideo"
};
const CATALOG_CACHE_PREFIX = "cino-catalog:v3:";
const VIEW_CACHE_PREFIX = "cino-views:v1:";
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const STATS_CACHE_TTL_MS = 60 * 1000;

const buttons = document.querySelectorAll(".menu button");
const tabs = document.querySelectorAll(".tab");
const shortcutButtons = document.querySelectorAll("[data-tab-trigger]");
const modal = document.getElementById("product-modal");
const modalImage = document.getElementById("modal-image");
const modalThumbs = document.getElementById("modal-thumbs");
const modalTitle = document.getElementById("modal-title");
const modalDescription = document.getElementById("modal-description");
const modalPriceText = document.getElementById("modal-price-text");
const modalDownload = document.getElementById("modal-download");
const modalClose = document.getElementById("modal-close");
const modalCancel = document.getElementById("modal-cancel");
const modalPrev = document.getElementById("modal-prev");
const modalNext = document.getElementById("modal-next");

let activeProduct = null;
let currentGalleryUrls = [];
let currentGalleryIndex = 0;
const productViews = new Map();
const productCatalogs = new Map();
const catalogRequests = new Map();
const catalogFetchedAt = new Map();
const statsRequests = new Map();
const statsFetchedAt = new Map();
const trackingRequests = [];
const loadedViewKeys = new Set();
const pendingViewTracks = new Map();

function activateTab(tabId) {
  buttons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });

  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.id === tabId);
  });

  if (DATA_MAP[tabId]) {
    loadData(tabId);
  }
}

buttons.forEach((btn) => {
  btn.addEventListener("click", () => {
    activateTab(btn.dataset.tab);
  });
});

shortcutButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const tabId = button.dataset.tabTrigger;

    if (tabId) {
      activateTab(tabId);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
});

function getProductContainer(type) {
  return document.querySelector(`#${type} .product-grid`);
}

function getProductKey(type, item) {
  return `${type}:${item.id || item.name || "unknown"}`;
}

function getViewStorageKey(type, item) {
  return `${VIEW_CACHE_PREFIX}${DATA_MAP[type] || type}:${item.id || item.name || "unknown"}`;
}

function buildApiUrl(action, params = {}) {
  const url = new URL(API_BASE_URL);
  url.searchParams.set("action", action);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

let jsonpRequestCounter = 0;

function requestJsonp(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `__cinoJsonp_${Date.now()}_${jsonpRequestCounter += 1}`;
    const script = document.createElement("script");
    const scriptUrl = new URL(url);
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("Yêu cầu views bị quá thời gian"));
    }, 10000);

    function cleanup() {
      window.clearTimeout(timeoutId);
      delete window[callbackName];
      script.remove();
    }

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("Không thể tải dữ liệu từ Apps Script"));
    };

    script.src = `${scriptUrl.toString()}&callback=${callbackName}`;
    document.head.appendChild(script);
  });
}

function buildR2Url(...segments) {
  const encodedPath = segments
    .filter(Boolean)
    .flatMap((segment) => String(segment).split("/"))
    .filter(Boolean)
    .map((part) => {
      let normalizedPart = String(part).trim();

      try {
        normalizedPart = decodeURIComponent(normalizedPart);
      } catch (_error) {
        // Giữ nguyên nếu part chưa được encode hợp lệ.
      }

      return encodeURIComponent(normalizedPart);
    })
    .join("/");

  return `${R2_PUBLIC_BASE_URL}/${encodedPath}`;
}

function buildR2CatalogUrl(type, subPath = "") {
  return buildR2Url(DATA_MAP[type], subPath, "data.json");
}

function buildDirectoryApiUrl(type) {
  const base = String(DIRECTORY_API_BASE_URL || "").trim();

  if (!base) {
    return "";
  }

  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const url = new URL("api/directories", normalizedBase);
  url.searchParams.set("category", DATA_MAP[type]);
  return url.toString();
}

function getItemSourcePath(type, item) {
  return String(item?._sourcePath || DATA_MAP[type] || "").replace(/^\/+|\/+$/g, "");
}

function getRawProductId(item) {
  return String(item?.rawId || item?.id || "").trim();
}

function parseDirectoryEntry(entry) {
  if (typeof entry === "string" && entry.trim()) {
    return { path: entry.trim(), name: entry.trim() };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const path = String(entry.directory || entry.folder || entry.path || "").trim();

  if (!path) {
    return null;
  }

  return {
    path,
    name: String(entry.name || entry.title || path).trim()
  };
}

function extractDirectoryEntries(data) {
  const candidates = Array.isArray(data)
    ? data
    : Array.isArray(data?.directories)
      ? data.directories
      : Array.isArray(data?.folders)
        ? data.folders
        : Array.isArray(data?.paths)
          ? data.paths
          : null;

  if (!candidates) {
    return [];
  }

  const entries = candidates
    .map((entry) => parseDirectoryEntry(entry))
    .filter(Boolean);

  return entries.length === candidates.length ? entries : [];
}

function scopeCatalogItems(type, data, options = {}) {
  const { directory = "", sourcePath = DATA_MAP[type] } = options;

  return normalizeData(data).map((item, index) => {
    const baseId = String(item.id || item.name || `item-${index + 1}`).trim();
    const scopedId = directory ? `${directory}/${baseId}` : baseId;

    return {
      ...item,
      id: scopedId,
      rawId: baseId,
      _directory: directory,
      _sourcePath: sourcePath
    };
  });
}

async function fetchDirectoryEntriesFromApi(type) {
  const url = buildDirectoryApiUrl(type);

  if (!url) {
    return [];
  }

  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Không thể tải danh sách thư mục (${response.status})`);
  }

  const data = await response.json();

  if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
    throw new Error(String(data.error));
  }

  return extractDirectoryEntries(
    Array.isArray(data?.directories) ? data.directories : data
  );
}

function getCatalogCacheKey(type) {
  return `${CATALOG_CACHE_PREFIX}${type}`;
}

function readCatalogCache(type) {
  try {
    const raw = window.localStorage.getItem(getCatalogCacheKey(type));

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    const items = normalizeData(parsed.items);
    const savedAt = Number(parsed.savedAt) || 0;

    if (!savedAt || items.length === 0) {
      return null;
    }

    if (Date.now() - savedAt > CATALOG_CACHE_TTL_MS) {
      window.localStorage.removeItem(getCatalogCacheKey(type));
      return null;
    }

    return { items, savedAt };
  } catch (_error) {
    return null;
  }
}

function writeCatalogCache(type, items) {
  try {
    window.localStorage.setItem(getCatalogCacheKey(type), JSON.stringify({
      savedAt: Date.now(),
      items
    }));
  } catch (_error) {
    // Bỏ qua lỗi quota/localStorage không khả dụng.
  }
}

function readPersistedView(type, item) {
  try {
    const raw = window.localStorage.getItem(getViewStorageKey(type, item));
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch (_error) {
    return 0;
  }
}

function writePersistedView(type, item, views) {
  try {
    window.localStorage.setItem(getViewStorageKey(type, item), String(Number(views) || 0));
  } catch (_error) {
    // Bỏ qua lỗi quota/localStorage không khả dụng.
  }
}

function normalizeData(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (data && typeof data === "object") {
    return [data];
  }

  return [];
}

function resolveCloudflareImage(type, item) {
  const folder = getItemSourcePath(type, item);
  const rawThumbnail = String(item.thumbnail || "").trim();

  if (!rawThumbnail) {
    return "";
  }

  try {
    const thumbnailUrl = new URL(rawThumbnail);
    const baseOrigin = new URL(R2_PUBLIC_BASE_URL).origin;

    if (thumbnailUrl.origin === baseOrigin) {
      return thumbnailUrl.toString();
    }

    const segments = thumbnailUrl.pathname.split("/").filter(Boolean);

    if (segments.length > 0) {
      segments[0] = folder;
      return `${baseOrigin}/${segments.join("/")}`;
    }
  } catch (_error) {
    if (rawThumbnail.startsWith("/")) {
      return `${R2_PUBLIC_BASE_URL}${rawThumbnail}`;
    }

    return buildR2Url(folder, rawThumbnail.replace(/^\.?\//, ""));
  }

  return rawThumbnail;
}

function buildGalleryUrls(type, item) {
  const folder = getItemSourcePath(type, item);
  const productId = getRawProductId(item);
  const explicitGallery = Array.isArray(item.gallery) ? item.gallery : [];
  const urls = [];

  explicitGallery.forEach((entry) => {
    if (typeof entry === "string" && entry.trim()) {
      const value = entry.trim();
      urls.push(value.startsWith("http") ? value : buildR2Url(folder, value.replace(/^\.?\//, "")));
    }
  });

  if (urls.length > 0) {
    return Array.from(new Set(urls));
  }

  urls.push(resolveCloudflareImage(type, item));

  const match = productId.match(/^([a-zA-Z_]+)(\d+)$/);

  if (match) {
    const prefix = match[1];
    const width = match[2].length;

    for (let index = 1; index <= 10; index += 1) {
      const suffix = String(index).padStart(width, "0");
      urls.push(buildR2Url(folder, `${prefix}${suffix}.JPG`));
      urls.push(buildR2Url(folder, `${prefix}${suffix}.jpg`));
      urls.push(buildR2Url(folder, `${prefix}${suffix}.PNG`));
      urls.push(buildR2Url(folder, `${prefix}${suffix}.png`));
      urls.push(buildR2Url(folder, `${prefix}${suffix}.WEBP`));
      urls.push(buildR2Url(folder, `${prefix}${suffix}.webp`));
    }
  }

  return Array.from(new Set(urls.filter(Boolean)));
}

function setCurrentViews(type, item, views) {
  const nextViews = Math.max(Number(views) || 0, readPersistedView(type, item));
  productViews.set(getProductKey(type, item), nextViews);
  writePersistedView(type, item, nextViews);
}

function getCurrentViews(type, item) {
  const key = getProductKey(type, item);

  if (!productViews.has(key)) {
    setCurrentViews(type, item, Math.max(Number(item.views) || 0, readPersistedView(type, item)));
  }

  return productViews.get(key) || 0;
}

function markViewsLoading(type, item) {
  loadedViewKeys.delete(getProductKey(type, item));
}

function markViewsLoaded(type, item, views) {
  setCurrentViews(type, item, views);
  loadedViewKeys.add(getProductKey(type, item));
}

function hasLoadedViews(type, item) {
  return loadedViewKeys.has(getProductKey(type, item));
}

function formatPrice(price) {
  const numericPrice = Number(price);
  return !numericPrice ? "Miễn phí" : `${numericPrice.toLocaleString("vi-VN")} VND`;
}

function formatViews(views) {
  return `${(Number(views) || 0).toLocaleString("vi-VN")} lượt xem`;
}

function getViewsDisplay(type, item) {
  return hasLoadedViews(type, item) ? formatViews(getCurrentViews(type, item)) : "Đang tải...";
}

function getDescriptionText(item) {
  return String(item.description || item.info || item.productInfo || "Chưa có thông tin sản phẩm.").trim();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDescriptionHtml(text) {
  const normalized = String(text || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "Chưa có thông tin sản phẩm.";
  }

  const sentences = normalized
    .match(/[^.]+(?:\.|$)/g)
    ?.map((part) => part.trim())
    .filter(Boolean);

  if (!sentences || sentences.length === 0) {
    return escapeHtml(normalized);
  }

  return sentences.map((part) => escapeHtml(part)).join("<br>");
}

function sendTrackingRequest(url) {
  const trackingUrl = `${url}&t=${Date.now()}`;

  if (typeof fetch === "function") {
    const request = fetch(trackingUrl, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      keepalive: true
    }).catch(() => {
      const img = new Image();
      trackingRequests.push(img);
      img.onload = img.onerror = () => {
        const index = trackingRequests.indexOf(img);
        if (index >= 0) {
          trackingRequests.splice(index, 1);
        }
      };
      img.src = trackingUrl;
    });

    trackingRequests.push(request);
    request.finally(() => {
      const index = trackingRequests.indexOf(request);
      if (index >= 0) {
        trackingRequests.splice(index, 1);
      }
    });
    return;
  }

  const img = new Image();
  trackingRequests.push(img);
  img.onload = img.onerror = () => {
    const index = trackingRequests.indexOf(img);
    if (index >= 0) {
      trackingRequests.splice(index, 1);
    }
  };
  img.src = trackingUrl;
}

function updateProductViewsUI(type, item) {
  const card = document.querySelector(`[data-product-key="${getProductKey(type, item)}"]`);

  if (card) {
    const cardViews = card.querySelector(".product-views");
    if (cardViews) {
      cardViews.textContent = getViewsDisplay(type, item);
    }
  }
}

function persistView(type, item) {
  sendTrackingRequest(buildApiUrl("incrementViews", {
    category: DATA_MAP[type],
    id: item.id,
    name: item.name
  }));
}

function trackView(type, item, options = {}) {
  const { persist = true } = options;

  setCurrentViews(type, item, getCurrentViews(type, item) + 1);
  updateProductViewsUI(type, item);

  if (persist) {
    persistView(type, item);
  }
}

function queuePendingViewTrack(type, item) {
  const key = getProductKey(type, item);
  pendingViewTracks.set(key, (pendingViewTracks.get(key) || 0) + 1);
}

function flushPendingViewTracks(type, item) {
  const key = getProductKey(type, item);
  const count = pendingViewTracks.get(key) || 0;

  if (count <= 0) {
    return;
  }

  pendingViewTracks.delete(key);

  for (let index = 0; index < count; index += 1) {
    trackView(type, item, { persist: false });
  }
}

function finalizeCatalogViews(type, catalog, statsItems = []) {
  const statsMap = new Map();

  statsItems.forEach((item) => {
    statsMap.set(getProductKey(type, item), Number(item.views) || 0);
  });

  catalog.forEach((item) => {
    const key = getProductKey(type, item);
    const nextViews = statsMap.has(key)
      ? statsMap.get(key)
      : getCurrentViews(type, item);

    markViewsLoaded(type, item, nextViews);
    flushPendingViewTracks(type, item);
  });

  if (catalog.length > 0) {
    renderProducts(type, catalog);
  }
}

function isCatalogFresh(type) {
  const fetchedAt = catalogFetchedAt.get(type) || 0;
  return fetchedAt > 0 && Date.now() - fetchedAt < CATALOG_CACHE_TTL_MS;
}

function primeCatalogState(type, catalog, fetchedAt = Date.now()) {
  productCatalogs.set(type, catalog);
  catalogFetchedAt.set(type, fetchedAt);

  catalog.forEach((item) => {
    const key = getProductKey(type, item);

    if (!productViews.has(key)) {
      setCurrentViews(type, item, item.views);
    }

    if (!loadedViewKeys.has(key)) {
      markViewsLoading(type, item);
    }
  });
}

function requestCatalog(type, options = {}) {
  const { force = false, onProgress } = options;
  const currentCatalog = productCatalogs.get(type);

  if (!force && currentCatalog?.length && isCatalogFresh(type)) {
    return Promise.resolve(currentCatalog);
  }

  if (catalogRequests.has(type)) {
    return catalogRequests.get(type);
  }

  const request = fetchCatalogFromR2(type, { onProgress })
    .then((catalog) => {
      primeCatalogState(type, catalog);
      writeCatalogCache(type, catalog);
      return catalog;
    })
    .finally(() => {
      catalogRequests.delete(type);
    });

  catalogRequests.set(type, request);
  return request;
}

function prefetchOtherCatalogs(activeType) {
  Object.keys(DATA_MAP).forEach((type) => {
    if (type === activeType) {
      return;
    }

    const currentCatalog = productCatalogs.get(type);
    if (currentCatalog?.length && isCatalogFresh(type)) {
      return;
    }

    requestCatalog(type).catch((error) => {
      console.error(`Lỗi prefetch ${type}:`, error);
    });
  });
}

async function loadData(type) {
  const container = getProductContainer(type);

  if (!container || !DATA_MAP[type]) {
    return;
  }

  const currentCatalog = productCatalogs.get(type);
  let hasRenderedCatalog = false;

  if (currentCatalog?.length) {
    renderProducts(type, currentCatalog);
    loadStatsInBackground(type);
    hasRenderedCatalog = true;

    if (isCatalogFresh(type)) {
      return;
    }
  } else {
    const cachedCatalog = readCatalogCache(type);

    if (cachedCatalog?.items?.length) {
      primeCatalogState(type, cachedCatalog.items, cachedCatalog.savedAt);
      renderProducts(type, cachedCatalog.items);
      loadStatsInBackground(type);
      hasRenderedCatalog = true;
    }
  }

  if (!hasRenderedCatalog) {
    container.innerHTML = '<p class="message">Đang tải sản phẩm...</p>';
  }

  try {
    const catalog = await requestCatalog(type, {
      force: !hasRenderedCatalog || !isCatalogFresh(type),
      onProgress: hasRenderedCatalog
        ? null
        : (partialCatalog) => {
            primeCatalogState(type, partialCatalog);
            renderProducts(type, partialCatalog);
          }
    });
    renderProducts(type, catalog);
    loadStatsInBackground(type);
  } catch (error) {
    if (hasRenderedCatalog) {
      console.error(`Lỗi làm mới ${type}:`, error);
      return;
    }

    console.error(`Lỗi khi load ${type}:`, error);
    const url = buildR2CatalogUrl(type);
    container.innerHTML = `
      <div class="message error">
        <strong>Không thể tải dữ liệu</strong>
        <span>${getLoadErrorMessage(error, url)}</span>
        <a href="${url}" target="_blank" rel="noopener noreferrer">Mở trực tiếp data.json</a>
      </div>
    `;
  }
}

async function fetchCatalogData(url) {
  const response = await fetch(url, { cache: "default" });

  if (!response.ok) {
    throw new Error(`Không thể tải dữ liệu (${response.status})`);
  }

  return response.json();
}

async function fetchCatalogsFromDirectoryEntries(type, directoryEntries, options = {}) {
  const { onProgress } = options;
  const mergedCatalog = [];
  const mergedKeys = new Set();

  await Promise.allSettled(directoryEntries.map(async (entry) => {
    const sourcePath = [DATA_MAP[type], entry.path].filter(Boolean).join("/");
    const nestedUrl = buildR2CatalogUrl(type, entry.path);
    const nestedData = await fetchCatalogData(nestedUrl);
    const scopedItems = scopeCatalogItems(type, nestedData, {
      directory: entry.path,
      sourcePath
    });

    scopedItems.forEach((item) => {
      const key = getProductKey(type, item);

      if (!mergedKeys.has(key)) {
        mergedKeys.add(key);
        mergedCatalog.push(item);
      }
    });

    if (typeof onProgress === "function" && mergedCatalog.length > 0) {
      onProgress([...mergedCatalog]);
    }
  }));

  if (mergedCatalog.length === 0) {
    throw new Error("Chưa có sản phẩm trong các thư mục con");
  }

  return mergedCatalog;
}

async function fetchCatalogFromR2(type, options = {}) {
  try {
    const apiDirectoryEntries = await fetchDirectoryEntriesFromApi(type);

    if (apiDirectoryEntries.length > 0) {
      return fetchCatalogsFromDirectoryEntries(type, apiDirectoryEntries, options);
    }
  } catch (error) {
    console.warn(`Không thể lấy danh sách thư mục từ API cho ${type}:`, error);
  }

  const rootUrl = buildR2CatalogUrl(type);
  let rootData;

  try {
    rootData = await fetchCatalogData(rootUrl);
  } catch (error) {
    const message = String(error && error.message ? error.message : error || "");

    if (message.includes("(404)")) {
      throw new Error(
        `Thiếu file manifest ${DATA_MAP[type]}/data.json. ` +
        `Nếu danh mục dùng nhiều thư mục con, hãy tạo file gốc để liệt kê chúng, ví dụ: ` +
        `{"directories":["layout PSC","combo 5 layout"]}, hoặc cấu hình DIRECTORY_API_BASE_URL để Worker tự liệt kê thư mục con.`
      );
    }

    throw error;
  }

  const directoryEntries = extractDirectoryEntries(rootData);

  if (directoryEntries.length > 0) {
    return fetchCatalogsFromDirectoryEntries(type, directoryEntries, options);
  }

  const normalizedData = scopeCatalogItems(type, rootData);

  if (normalizedData.length === 0) {
    throw new Error("Dữ liệu JSON không đúng định dạng mong đợi");
  }

  return normalizedData;
}

async function loadStatsInBackground(type) {
  const fetchedAt = statsFetchedAt.get(type) || 0;

  if (fetchedAt > 0 && Date.now() - fetchedAt < STATS_CACHE_TTL_MS) {
    return;
  }

  if (statsRequests.has(type)) {
    return statsRequests.get(type);
  }

  const url = buildApiUrl("views", { category: DATA_MAP[type] });
  const request = (async () => {
    try {
      const data = await requestJsonp(url);
      if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
        throw new Error(String(data.error));
      }
      const normalizedData = normalizeData(data);
      const catalog = productCatalogs.get(type) || [];

      finalizeCatalogViews(type, catalog, normalizedData);

      statsFetchedAt.set(type, Date.now());
    } catch (error) {
      console.error(`Lỗi load thống kê nền ${type}:`, error);
      const catalog = productCatalogs.get(type) || [];
      finalizeCatalogViews(type, catalog);
    } finally {
      statsRequests.delete(type);
    }
  })();

  statsRequests.set(type, request);
  return request;
}

function getLoadErrorMessage(error, url) {
  const message = String(error && error.message ? error.message : error || "").trim();

  if (message.includes("Thiếu file manifest")) {
    return `${message} Tạo file này trên R2 rồi tải lại trang.`;
  }

  if (!message || message === "Failed to fetch") {
    return `Không thể kết nối đến ${url}. Kiểm tra dữ liệu R2 đã public và URL đã đúng chưa.`;
  }

  return `${message}. Kiểm tra cấu hình rồi thử lại.`;
}

function renderProducts(type, data) {
  const container = getProductContainer(type);

  if (!container) {
    return;
  }

  container.innerHTML = "";

  if (data.length === 0) {
    container.innerHTML = '<p class="message">Chưa có sản phẩm trong danh mục này.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();

  data.forEach((item) => {
    const card = document.createElement("article");
    const thumbnail = resolveCloudflareImage(type, item);
    const name = item.name || "Không tên";
    const price = formatPrice(item.price);
    const views = getViewsDisplay(type, item);
    const isFree = !Number(item.price);

    card.className = "product";
    card.tabIndex = 0;
    card.dataset.productKey = getProductKey(type, item);

    card.innerHTML = `
      <div class="product-media">
        <img src="${thumbnail}" alt="${name}">
        <span class="product-badge ${isFree ? "is-free" : "is-paid"}">
          ${isFree ? "Miễn phí" : "Trả phí"}
        </span>
      </div>
      <div class="product-info">
        <div class="product-meta product-meta-stack">
          <span class="product-views">${views}</span>
        </div>
        <h4>${name}</h4>
        <div class="product-footer">
          <p>${price}</p>
          <span class="product-cta">Chi tiết</span>
        </div>
      </div>
    `;

    const image = card.querySelector("img");
    image.addEventListener("error", () => {
      image.src =
        "data:image/svg+xml;charset=UTF-8," +
        encodeURIComponent(`
          <svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
            <rect width="600" height="400" fill="#dbe4f0" />
            <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
              fill="#6b7280" font-family="Segoe UI, sans-serif" font-size="28">
              Không có ảnh
            </text>
          </svg>
        `);
    });

    card.addEventListener("click", () => openProductModal(type, item));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openProductModal(type, item);
      }
    });

    fragment.appendChild(card);
  });

  container.appendChild(fragment);
}

function updateGalleryNavState() {
  const shouldDisable = currentGalleryUrls.length <= 1;

  if (modalPrev) {
    modalPrev.disabled = shouldDisable;
  }

  if (modalNext) {
    modalNext.disabled = shouldDisable;
  }
}

function setMainModalImage(index) {
  if (!currentGalleryUrls.length) {
    return;
  }

  currentGalleryIndex = ((index % currentGalleryUrls.length) + currentGalleryUrls.length) % currentGalleryUrls.length;
  modalImage.src = currentGalleryUrls[currentGalleryIndex];

  if (!modalThumbs) {
    updateGalleryNavState();
    return;
  }

  modalThumbs.querySelectorAll(".modal-thumb").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.index) === currentGalleryIndex);
  });

  updateGalleryNavState();
}

function changeGalleryImage(step) {
  if (currentGalleryUrls.length <= 1) {
    return;
  }

  setMainModalImage(currentGalleryIndex + step);
}

function buildModalGallery(type, item) {
  if (!modalThumbs) {
    return;
  }

  modalThumbs.innerHTML = "";
  const urls = buildGalleryUrls(type, item);
  const fallbackImage = resolveCloudflareImage(type, item);
  currentGalleryUrls = urls.length > 0 ? urls : [fallbackImage];
  currentGalleryIndex = 0;

  currentGalleryUrls.forEach((url, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "modal-thumb";
    button.dataset.index = String(index);

    const image = document.createElement("img");
    image.alt = `${item.name || "Ảnh sản phẩm"} ${index + 1}`;
    image.loading = "lazy";
    image.src = url;

    image.addEventListener("error", () => {
      if (modalImage.src === image.src) {
        modalImage.src = fallbackImage;
      }
      button.remove();
    });

    button.addEventListener("click", () => {
      setMainModalImage(index);
    });

    button.appendChild(image);
    modalThumbs.appendChild(button);
  });

  setMainModalImage(0);
}

function openProductModal(type, item) {
  if (!item || !modal) {
    return;
  }

  activeProduct = { type, item };

  const thumbnail = resolveCloudflareImage(type, item);
  const reallink = String(item.reallink || "").trim();
  const hasDownload = /^https?:\/\//i.test(reallink);

  modalImage.src = thumbnail;
  modalImage.alt = item.name || "Sản phẩm";
  modalTitle.textContent = item.name || "Không tên";
  modalDescription.innerHTML = formatDescriptionHtml(getDescriptionText(item));
  modalPriceText.textContent = formatPrice(item.price);
  modalDownload.disabled = !hasDownload;
  modalDownload.textContent = hasDownload ? "Tải xuống" : "Chưa có link tải";
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  buildModalGallery(type, item);
  persistView(type, item);

  if (hasLoadedViews(type, item)) {
    trackView(type, item, { persist: false });
  } else {
    queuePendingViewTrack(type, item);
  }
}

function closeProductModal() {
  if (!modal) {
    return;
  }

  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function handleDownload() {
  if (!activeProduct) {
    return;
  }

  const { item } = activeProduct;
  const adlink = String(item.adlink || "").trim();
  const reallink = String(item.reallink || "").trim();

  if (/^https?:\/\//i.test(adlink)) {
    window.open(adlink, "_blank");
  }

  if (/^https?:\/\//i.test(reallink)) {
    window.open(reallink, "_blank");
  }

  closeProductModal();
}

window.addEventListener("DOMContentLoaded", () => {
  const defaultTab = document.querySelector(".menu button.active");

  if (!defaultTab) {
    return;
  }

  const initialTab = defaultTab.dataset.tab;
  activateTab(initialTab);

  window.setTimeout(() => {
    prefetchOtherCatalogs(initialTab);
  }, 2000);
});

if (modal) {
  modal.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.dataset.closeModal === "true") {
      closeProductModal();
    }
  });
}

if (modalClose) {
  modalClose.addEventListener("click", closeProductModal);
}

if (modalCancel) {
  modalCancel.addEventListener("click", closeProductModal);
}

if (modalDownload) {
  modalDownload.addEventListener("click", handleDownload);
}

if (modalPrev) {
  modalPrev.addEventListener("click", () => {
    changeGalleryImage(-1);
  });
}

if (modalNext) {
  modalNext.addEventListener("click", () => {
    changeGalleryImage(1);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeProductModal();
    return;
  }

  if (modal?.classList.contains("hidden")) {
    return;
  }

  if (event.key === "ArrowLeft") {
    changeGalleryImage(-1);
  }

  if (event.key === "ArrowRight") {
    changeGalleryImage(1);
  }
});
