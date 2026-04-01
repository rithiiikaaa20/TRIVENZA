const isLocalFrontend =
  window.location.protocol === "file:" ||
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

const API_BASE = isLocalFrontend && window.location.port !== "5000"
  ? "http://localhost:5000/api"
  : "/api";
const STORAGE_KEYS = {
  user: "trivenzaUser",
  legacyUser: "currentUser",
  events: "trivenza_events",
};

let currentPaymentId = null;
let currentEventPayment = null;
let currentEditFundraiserId = null;
let communityChatPoller = null;
let editingEventId = null;
let loadedEvents = [];

function showToast(message, type = "success") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const icon = type === "success"
    ? '<i class="fa-solid fa-circle-check"></i>'
    : '<i class="fa-solid fa-circle-exclamation"></i>';
  toast.innerHTML = `${icon} <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  }, 3000);
}

function showConfirmModal(message, onConfirm) {
  let modal = document.getElementById("confirm-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "confirm-modal";
    modal.style.cssText = "position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);backdrop-filter:blur(8px);";
    modal.innerHTML = `
      <div style="background:#fff;border-radius:32px;padding:40px 36px;max-width:400px;width:90%;box-shadow:0 24px 60px rgba(0,0,0,0.15);text-align:center;font-family:'Plus Jakarta Sans',sans-serif">
        <div style="width:56px;height:56px;border-radius:50%;background:#FEF2F2;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
          <i class="fa-solid fa-triangle-exclamation" style="color:#EF4444;font-size:22px"></i>
        </div>
        <h3 style="font-size:17px;font-weight:800;color:#1F2937;margin-bottom:8px;">Are you sure?</h3>
        <p id="confirm-modal-msg" style="font-size:14px;font-weight:500;color:#6B7280;margin-bottom:28px;line-height:1.6"></p>
        <div style="display:flex;gap:12px;justify-content:center">
          <button id="confirm-modal-cancel" style="padding:12px 28px;border-radius:50px;border:2px solid #E5E7EB;font-weight:700;font-size:13px;cursor:pointer;background:white;color:#6B7280;transition:all .2s">Cancel</button>
          <button id="confirm-modal-ok" style="padding:12px 28px;border-radius:50px;border:none;background:#EF4444;color:white;font-weight:700;font-size:13px;cursor:pointer;transition:all .2s">Yes, Delete</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  document.getElementById("confirm-modal-msg").textContent = message;
  modal.style.display = "flex";
  document.getElementById("confirm-modal-cancel").onclick = () => { modal.style.display = "none"; };
  document.getElementById("confirm-modal-ok").onclick = () => {
    modal.style.display = "none";
    onConfirm();
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeUser(user) {
  if (!user) return null;
  const username = user.username || user.name || "";
  return {
    id: user.id || user._id || "",
    username,
    name: username,
    email: user.email || "",
    phone: user.phone || "",
    profilePic: user.profilePic || "",
    interests: Array.isArray(user.interests) ? user.interests : [],
  };
}

function getCurrentUser() {
  try {
    const storedUser = localStorage.getItem(STORAGE_KEYS.user) || localStorage.getItem(STORAGE_KEYS.legacyUser) || "null";
    return normalizeUser(JSON.parse(storedUser));
  } catch {
    return null;
  }
}

function getStoredUsername() {
  try {
    const storedUser = localStorage.getItem(STORAGE_KEYS.legacyUser) || localStorage.getItem(STORAGE_KEYS.user) || "null";
    const parsed = JSON.parse(storedUser);
    return String(parsed?.username || parsed?.name || "").trim();
  } catch {
    return "";
  }
}

function saveCurrentUser(user) {
  const normalized = normalizeUser(user);
  if (!normalized) return;
  const serialized = JSON.stringify(normalized);
  localStorage.setItem(STORAGE_KEYS.user, serialized);
  localStorage.setItem(STORAGE_KEYS.legacyUser, serialized);
}

function requireAuth(message = "Please login to continue") {
  const user = getCurrentUser();
  if (!user) {
    showToast(message, "error");
    return null;
  }
  return user;
}

function getDisplayName(user) {
  if (!user) return "User";
  return user.username || user.name || "User";
}

function sanitizeCreatedBy(value) {
  const name = String(value || "").trim();
  if (!name || name.toUpperCase() === "UNKNOWN USER") return "";
  return name;
}

function getFieldValue(ids = []) {
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) return element.value.trim();
  }
  return "";
}

function getByAnyId(ids = []) {
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) return element;
  }
  return null;
}

function formatEventDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDateTimeLocalValue(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (num) => String(num).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function readCachedEvents() {
  try {
    const events = JSON.parse(localStorage.getItem(STORAGE_KEYS.events) || "[]");
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

function saveCachedEvents(events) {
  localStorage.setItem(STORAGE_KEYS.events, JSON.stringify(events));
}

function sortByCreatedAtDesc(items) {
  return [...items].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function mergeEvents(serverEvents, localEvents, communityId = "") {
  const filteredLocal = localEvents.filter((eventItem) => (eventItem.communityId || "") === communityId);
  const merged = [...serverEvents];

  filteredLocal.forEach((localItem) => {
    const exists = merged.some((serverItem) =>
      serverItem.id === localItem.id ||
      (
        serverItem.title === localItem.title &&
        serverItem.date === localItem.date &&
        serverItem.location === localItem.location &&
        (serverItem.communityId || "") === (localItem.communityId || "")
      )
    );
    if (!exists) merged.push(localItem);
  });

  return sortByCreatedAtDesc(merged);
}

function normalizeEventRecord(eventItem = {}) {
  return {
    ...eventItem,
    id: eventItem.id || eventItem._id || "",
    createdBy: sanitizeCreatedBy(eventItem.createdBy) || "Anonymous",
    price: Number(eventItem.price || 0),
    creator_id: eventItem.creator_id || "",
    communityId: eventItem.communityId || "",
    createdAt: eventItem.createdAt || "",
  };
}

function isMongoLikeId(value = "") {
  return /^[a-f\d]{24}$/i.test(String(value).trim());
}

function contribute() {
  const amount = window.prompt("Enter contribution amount:");

  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    window.alert("Please enter a valid amount");
    return;
  }

  window.alert(`Payment of ₹${amount} successful (dummy payment)`);
}

function upsertCachedEvent(eventItem, tempId = null) {
  const cached = readCachedEvents();
  const next = cached.filter((item) => item.id !== eventItem.id && (!tempId || item.id !== tempId));
  next.unshift(eventItem);
  saveCachedEvents(sortByCreatedAtDesc(next));
}

function replaceCachedEventsForScope(events, communityId = "") {
  const cached = readCachedEvents();
  const next = cached.filter((item) => (item.communityId || "") !== communityId);
  saveCachedEvents(sortByCreatedAtDesc([...next, ...events]));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => resolve(event.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setButtonLoading(button, loadingText) {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = loadingText;
  return () => {
    button.disabled = false;
    button.innerHTML = original;
  };
}

function toggleImagePreview(previewId, src = "") {
  const preview = document.getElementById(previewId);
  if (!preview) return;
  const img = preview.querySelector("img");
  if (src) {
    if (img) img.src = src;
    preview.classList.remove("hidden");
  } else {
    if (img) img.src = "";
    preview.classList.add("hidden");
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    throw new Error(data?.error || data?.message || "Request failed");
  }
  return data;
}

async function syncCurrentUserProfile() {
  const user = getCurrentUser();
  if (!user?.id) return;

  try {
    const profile = await fetchJson(`${API_BASE}/profile/${user.id}`);
    saveCurrentUser(profile);
  } catch {
    // Keep local session if backend is unavailable.
  }
}

async function signupUser(event) {
  event.preventDefault();
  const username = document.getElementById("signup-username")?.value.trim();
  const password = document.getElementById("signup-password")?.value;
  const submitButton = event.target.querySelector("button[type='submit'], button:not([type])");

  if (!username || !password) {
    showToast("Username and password are required", "error");
    return;
  }

  const restoreButton = setButtonLoading(submitButton, '<i class="fa-solid fa-spinner fa-spin"></i> Creating account...');

  try {
    const data = await fetchJson(`${API_BASE}/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (data.user) saveCurrentUser(data.user);
    showToast("Account created successfully", "success");
    setTimeout(() => window.location.replace("/profile"), 500);
  } catch (error) {
    showToast(error.message || "Signup failed", "error");
  } finally {
    restoreButton();
  }
}

async function loginUser(event) {
  event.preventDefault();
  const username = document.getElementById("login-username")?.value.trim();
  const password = document.getElementById("login-password")?.value;
  const submitButton = event.target.querySelector("button[type='submit'], button:not([type])");

  if (!username || !password) {
    showToast("Username and password are required", "error");
    return;
  }

  const restoreButton = setButtonLoading(submitButton, '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...');

  try {
    const data = await fetchJson(`${API_BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    saveCurrentUser(data.user);
    showToast("Logged in successfully", "success");
    setTimeout(() => window.location.replace("/"), 400);
  } catch (error) {
    showToast(error.message || "Login failed", "error");
  } finally {
    restoreButton();
  }
}

function togglePassword() {
  const input = document.getElementById("login-password");
  const button = document.getElementById("toggle-password-btn");
  if (!input) return;

  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  if (button) button.textContent = isHidden ? "Hide" : "Show";
}

function forgotPassword() {
  const seededUsername = document.getElementById("login-username")?.value.trim() || "";
  const username = window.prompt("Enter your username", seededUsername);
  if (!username) return;
  showToast(`Password reset link sent to ${username} (dummy flow)`, "success");
}

function logoutUser() {
  localStorage.removeItem(STORAGE_KEYS.user);
  localStorage.removeItem(STORAGE_KEYS.legacyUser);
  window.location.replace("/login");
}

async function createCommunity(event) {
  event.preventDefault();
  const user = requireAuth("You must be logged in to create a community");
  if (!user) return;

  try {
    const name = document.getElementById("community-name").value.trim();
    const category = document.getElementById("community-category").value.trim();
    const description = document.getElementById("community-description").value.trim();
    const imageInput = document.getElementById("community-image");

    if (!name || !category || !description) {
      showToast("Please complete all required fields", "error");
      return;
    }

    let image = "";
    if (imageInput?.files?.[0]) {
      image = await fileToDataUrl(imageInput.files[0]);
    }

    if (!image) {
      const cat = category.toLowerCase();
      if (cat.includes("run")) image = "https://images.unsplash.com/photo-1571008887538-b36bb32f4571?auto=format&fit=crop&q=80&w=800";
      else if (cat.includes("yoga") || cat.includes("meditat")) image = "https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&q=80&w=800";
      else if (cat.includes("tech") || cat.includes("code")) image = "https://images.unsplash.com/photo-1515879218367-8466d910aaa4?auto=format&fit=crop&q=80&w=800";
      else if (cat.includes("fit") || cat.includes("gym")) image = "https://images.unsplash.com/photo-1517836357463-d25dfeac3438?auto=format&fit=crop&q=80&w=800";
      else if (cat.includes("art") || cat.includes("paint")) image = "https://images.unsplash.com/photo-1460661419201-fd4cecdf8a8b?auto=format&fit=crop&q=80&w=800";
      else image = "https://images.unsplash.com/photo-1528605105345-5344ea20e269?auto=format&fit=crop&q=80&w=800";
    }

    await fetchJson(`${API_BASE}/communities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        category,
        description,
        image,
        gallery: [],
        creator_id: user.id,
        createdBy: sanitizeCreatedBy(getDisplayName(user)) || "User",
      }),
    });

    event.target.reset();
    toggleImagePreview("create-image-preview");
    showToast("Community created successfully", "success");
    loadCommunities();
  } catch (error) {
    showToast(error.message || "Could not create community", "error");
  }
}

function communityCardMarkup(comm, index = 0) {
  const createdBy = sanitizeCreatedBy(comm.createdBy) || "User";
  return `
    <div class="soft-card soft-shadow flex flex-col h-full overflow-hidden border border-[#D68D8D]/5" data-aos="fade-up" data-aos-delay="${index * 100}">
      <div class="relative h-56 img-wrapper">
        <img src="${escapeHtml(comm.image || "https://images.unsplash.com/photo-1528605105345-5344ea20e269?auto=format&fit=crop&q=80&w=600")}" class="w-full h-full object-cover img-zoom">
        <span class="absolute top-5 left-5 glass-panel text-[#1F2937] text-[10px] font-bold uppercase tracking-widest px-4 py-2 rounded-full border border-white/50">
          ${escapeHtml(comm.category || "General")}
        </span>
      </div>
      <div class="p-8 flex flex-col flex-grow">
        <h3 class="text-2xl font-serif font-black text-[#1F2937] mb-2 leading-tight">${escapeHtml(comm.name)}</h3>
        <p class="text-[11px] font-bold uppercase tracking-[0.18em] text-[#D68D8D] mb-4">Created by: ${escapeHtml(createdBy)}</p>
        <p class="text-gray-400 text-sm mb-8 line-clamp-2 flex-grow leading-relaxed font-medium">${escapeHtml(comm.description)}</p>
        <div class="mt-auto flex items-center justify-between border-t border-[#F9F7F2] pt-6">
          <div class="text-xs font-bold text-gray-400 flex items-center gap-2 uppercase tracking-tight">
            <span class="w-7 h-7 rounded-full bg-[#D68D8D]/10 flex items-center justify-center text-[#D68D8D]"><i class="fa-solid fa-user-group text-[10px]"></i></span>
            ${escapeHtml(comm.members || 0)} Members
          </div>
          <button onclick="window.location.href='/community/${escapeHtml(comm.id)}'" class="btn-outline-lilac text-[10px] uppercase tracking-widest px-6 py-2.5">
            Enter Space
          </button>
        </div>
      </div>
    </div>
  `;
}

async function loadCommunities() {
  const container = document.getElementById("community-list");
  if (!container) return;

  try {
    const communities = (await fetchJson(`${API_BASE}/communities`))
      .map((community) => ({
        ...community,
        createdBy: sanitizeCreatedBy(community.createdBy),
      }))
      .filter((community) => community.createdBy);
    container.innerHTML = "";

    if (!communities.length) {
      container.innerHTML = `<div class="col-span-full text-center py-20"><i class="fa-solid fa-people-group text-5xl text-[#D68D8D]/30 mb-4 block"></i><p class="text-gray-400 font-semibold">No communities yet. Be the first to create one!</p></div>`;
      return;
    }

    container.innerHTML = communities.map((comm, index) => communityCardMarkup(comm, index)).join("");
  } catch (error) {
    console.error("Error loading communities:", error);
    container.innerHTML = `<p class="col-span-full text-center text-red-500 font-medium py-8 bg-red-50 rounded-xl border border-red-100">Failed to load communities. Please ensure the backend is running.</p>`;
  }
}

async function joinCommunity(id) {
  try {
    const data = await fetchJson(`${API_BASE}/communities/${id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: getCurrentUser()?.id || null }),
    });
    showToast(data.message || "Community updated", "success");
    loadCommunities();
  } catch (error) {
    showToast(error.message || "Could not update community membership", "error");
  }
}

function buildEventPayload({ title, date, location, description, image = "", communityId = "" }, user, tempId = "") {
  return {
    id: tempId || `local-${Date.now()}`,
    title,
    date,
    location,
    description,
    image,
    price: 0,
    createdBy: sanitizeCreatedBy(getDisplayName(user)) || "User",
    creator_id: user.id,
    createdAt: new Date().toISOString(),
    communityId,
  };
}

async function createEvent(event) {
  event.preventDefault();
  const user = getCurrentUser();

  const form = event.target;
  const submitButton = form.querySelector("button[type='submit'], button:not([type])");
  const title = getFieldValue(["title", "event-title"]);
  const date = getFieldValue(["date", "event-date"]);
  const location = getFieldValue(["location", "event-location"]);
  const description = getFieldValue(["description", "event-description"]);
  const priceInput = getByAnyId(["price", "event-price"]);
  const price = Math.max(Number(priceInput?.value || 0), 0);
  const imageInput = document.getElementById("event-image");

  if (!title || !date || !location || !description) {
    showToast("Please fill in title, date, location, and description", "error");
    return;
  }

  const selectedDate = new Date(date);
  const now = new Date();
  if (Number.isNaN(selectedDate.getTime())) {
    showToast("Please choose a valid date and time", "error");
    return;
  }
  if (selectedDate <= now) {
    showToast("Please select a future date and time", "error");
    return;
  }

  const restoreButton = setButtonLoading(
    submitButton,
    editingEventId ? '<i class="fa-solid fa-spinner fa-spin"></i> Updating...' : '<i class="fa-solid fa-spinner fa-spin"></i> Publishing...'
  );

  try {
    let image = "";
    if (imageInput?.files?.[0]) {
      image = await fileToDataUrl(imageInput.files[0]);
    }

    const existingEvent = editingEventId ? loadedEvents.find((item) => item.id === editingEventId) : null;
    const payload = {
      title,
      date: selectedDate.toISOString(),
      location,
      description,
      image: image || existingEvent?.image || "",
      price,
      createdBy: sanitizeCreatedBy(getStoredUsername() || user?.username || user?.name || user?.email) || "Anonymous",
      creator_id: user?.id || "",
      createdAt: existingEvent?.createdAt || new Date().toISOString(),
    };

    let savedEvent = null;
    if (editingEventId) {
      if (!user?.id) {
        showToast("Please login to edit an event", "error");
        return;
      }

      const data = await fetchJson(`${API_BASE}/events/${editingEventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          user_id: user.id,
        }),
      });
      savedEvent = data.event || { ...existingEvent, ...payload, id: editingEventId };
      upsertCachedEvent(savedEvent, editingEventId);
      showToast("Event updated successfully", "success");
    } else {
      const draft = {
        ...buildEventPayload(
          { title, date: payload.date, location, description, image: payload.image },
          user || { id: "", username: "Anonymous", name: "Anonymous" }
        ),
        price,
        createdBy: payload.createdBy,
        creator_id: payload.creator_id,
      };
      upsertCachedEvent(draft);
      await loadEvents();

      const data = await fetchJson(`${API_BASE}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      savedEvent = normalizeEventRecord(data.event || data || draft);
      upsertCachedEvent(savedEvent, draft.id);
      showToast("Event created successfully", "success");
    }

    cancelEventEdit(false);
    form.reset();
    if (priceInput) priceInput.value = "0";
    toggleImagePreview("event-image-preview");
    await loadEvents();
  } catch (error) {
    showToast(error.message || "Failed to create event", "error");
  } finally {
    restoreButton();
  }
}

function previewEventImage(event) {
  const file = event.target.files?.[0];
  if (!file) {
    toggleImagePreview("event-image-preview");
    return;
  }

  const reader = new FileReader();
  reader.onload = (loadEvent) => toggleImagePreview("event-image-preview", loadEvent.target.result);
  reader.readAsDataURL(file);
}

function eventCardMarkup(ev, index = 0) {
  const safeTitle = escapeHtml(ev.title);
  const createdBy = sanitizeCreatedBy(ev.createdBy) || "User";
  const price = Number(ev.price || 0);
  const currentUsername = sanitizeCreatedBy(getStoredUsername());
  const isCreator = Boolean(currentUsername) && createdBy === currentUsername;
  const deleteId = ev._id || ev.id;
  return `
    <div class="soft-card soft-shadow flex flex-col h-full overflow-hidden border border-[#D68D8D]/5" data-aos="fade-up" data-aos-delay="${index * 100}">
      <div class="w-full h-60 img-wrapper relative">
        <img src="${escapeHtml(ev.image || "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=80&w=800")}" class="w-full h-full object-cover img-zoom">
        <div class="absolute bottom-5 left-5 glass-panel text-[#1F2937] text-[10px] font-bold uppercase tracking-widest px-4 py-2 rounded-full flex items-center gap-2 border border-white/50">
          <i class="fa-solid fa-location-dot text-[#D68D8D]"></i> ${escapeHtml(ev.location)}
        </div>
        ${isCreator ? `
          <div class="absolute top-4 right-4 flex gap-2">
            <button onclick="editEvent('${escapeHtml(ev.id)}')" class="w-9 h-9 bg-white/90 backdrop-blur shadow-sm rounded-full flex items-center justify-center text-gray-700 hover:bg-[#D68D8D] hover:text-white transition" title="Edit Event">
              <i class="fa-solid fa-pen-to-square text-sm"></i>
            </button>
            <button onclick="deleteEvent('${escapeHtml(deleteId)}')" class="w-9 h-9 bg-white/90 backdrop-blur shadow-sm rounded-full flex items-center justify-center text-gray-700 hover:bg-red-500 hover:text-white transition" title="Delete Event">
              <i class="fa-solid fa-trash text-sm"></i>
            </button>
          </div>` : ""}
      </div>
      <div class="p-8 flex flex-col flex-grow">
        <p class="text-[#A8B5A2] text-[10px] font-black uppercase tracking-[0.15em] mb-3 flex items-center gap-2">
          <i class="fa-regular fa-calendar"></i> ${escapeHtml(formatEventDate(ev.date))}
        </p>
        <h3 class="text-2xl font-serif font-black text-[#1F2937] mb-2 leading-tight">${safeTitle}</h3>
        <p class="text-[11px] font-bold uppercase tracking-[0.18em] text-[#D68D8D] mb-4">Created by: ${escapeHtml(createdBy)}</p>
        <p class="text-[11px] font-bold uppercase tracking-[0.18em] text-[#A8B5A2] mb-4">${price > 0 ? `Price: Rs.${escapeHtml(price.toFixed(2))}` : "Free Event"}</p>
        <p class="text-gray-400 text-sm font-medium line-clamp-2 mb-8 leading-relaxed">${escapeHtml(ev.description)}</p>
        <div class="mt-auto pt-6 border-t border-[#F9F7F2] text-center">
          <button onclick="joinEvent('${escapeHtml(ev.id)}', ${price})" class="btn-outline-lilac text-[10px] uppercase tracking-widest px-8 py-3 w-full">${price > 0 ? "Pay & Join" : "Join Free"}</button>
        </div>
      </div>
    </div>
  `;
}

function syncEventEditorUi() {
  const submitButton = document.getElementById("event-submit-btn");
  const cancelButton = document.getElementById("event-cancel-btn");
  if (submitButton) submitButton.textContent = editingEventId ? "Update Event" : "Publish Event";
  if (cancelButton) cancelButton.classList.toggle("hidden", !editingEventId);
}

function cancelEventEdit(resetForm = true) {
  editingEventId = null;
  if (resetForm) {
    const eventForm = document.getElementById("eventForm");
    eventForm?.reset();
    const priceInput = getByAnyId(["price", "event-price"]);
    if (priceInput) priceInput.value = "0";
    toggleImagePreview("event-image-preview");
  }
  syncEventEditorUi();
}

function editEvent(id) {
  const eventItem = loadedEvents.find((item) => item.id === id);
  if (!eventItem) {
    showToast("Event details could not be loaded", "error");
    return;
  }

  editingEventId = id;
  const titleInput = getByAnyId(["title", "event-title"]);
  const dateInput = getByAnyId(["date", "event-date"]);
  const locationInput = getByAnyId(["location", "event-location"]);
  const descriptionInput = getByAnyId(["description", "event-description"]);
  const priceInput = getByAnyId(["price", "event-price"]);

  if (titleInput) titleInput.value = eventItem.title || "";
  if (dateInput) dateInput.value = toDateTimeLocalValue(eventItem.date);
  if (locationInput) locationInput.value = eventItem.location || "";
  if (descriptionInput) descriptionInput.value = eventItem.description || "";
  if (priceInput) priceInput.value = String(Number(eventItem.price || 0));
  toggleImagePreview("event-image-preview", eventItem.image || "");
  syncEventEditorUi();
  document.getElementById("eventForm")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteEvent(id) {
  showConfirmModal("Are you sure you want to remove this event?", async () => {
    try {
      const currentUser = JSON.parse(localStorage.getItem("currentUser") || "null")?.username || getStoredUsername();
      console.log("Deleting event:", id, "User:", currentUser);

      if (!currentUser) {
        window.alert("Please login to delete your event");
        return;
      }

      if (isMongoLikeId(id)) {
        const res = await fetch(`http://localhost:5000/api/events/${id}?user=${encodeURIComponent(currentUser)}`, {
          method: "DELETE",
        });
        const data = await res.json().catch(() => ({}));

        if (res.status === 403) {
          window.alert("You can only delete your own events");
          return;
        }

        if (!res.ok) {
          window.alert(data?.message || data?.error || "Failed to delete event");
          return;
        }

        window.alert(data?.message || "Event deleted successfully");
      } else {
        window.alert("Event deleted successfully");
      }

      loadedEvents = loadedEvents.filter((item) => item.id !== id);
      saveCachedEvents(readCachedEvents().filter((item) => item.id !== id));
      if (editingEventId === id) cancelEventEdit();
      await loadEvents();
    } catch (error) {
      window.alert(error.message || "Failed to delete event");
    }
  });
}

function joinEvent(id, price) {
  const eventItem = loadedEvents.find((item) => item.id === id);
  if (!eventItem) {
    showToast("Event not found", "error");
    return;
  }

  if (price > 0) {
    openEventPaymentModal(eventItem);
    return;
  }

  showToast(`Joined successfully: ${eventItem.title}`, "success");
}

function ensureEventPaymentModal() {
  if (document.getElementById("event-payment-modal")) return;

  const modal = document.createElement("div");
  modal.id = "event-payment-modal";
  modal.className = "hidden fixed inset-0 z-[110] flex items-center justify-center px-4";
  modal.style.cssText = "background:rgba(15,23,42,0.45);backdrop-filter:blur(10px)";
  modal.innerHTML = `
    <div style="background:#fff;border-radius:36px;padding:40px 36px;max-width:460px;width:100%;box-shadow:0 28px 70px rgba(15,23,42,0.22);position:relative;overflow:hidden;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="position:absolute;inset:0 0 auto 0;height:5px;background:linear-gradient(90deg,#D68D8D,#A8B5A2)"></div>
      <button onclick="closeEventPaymentModal()" style="position:absolute;top:18px;right:18px;background:none;border:none;font-size:20px;color:#9CA3AF;cursor:pointer">
        <i class="fa-solid fa-xmark"></i>
      </button>
      <div style="text-align:center;margin-bottom:28px">
        <div style="width:60px;height:60px;border-radius:50%;background:#FFF5F5;margin:0 auto 14px;display:flex;align-items:center;justify-content:center">
          <i class="fa-solid fa-credit-card" style="color:#D68D8D;font-size:24px"></i>
        </div>
        <h2 style="font-size:24px;font-weight:900;color:#1F2937;margin-bottom:8px">Dummy Payment Gateway</h2>
        <p style="font-size:13px;line-height:1.6;color:#6B7280;font-weight:500">
          You are paying for <span id="event-payment-title" style="color:#D68D8D;font-weight:800">this event</span>
        </p>
      </div>
      <div style="background:#F9FAFB;border:1px solid #F3F4F6;border-radius:24px;padding:20px;margin-bottom:22px">
        <p style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.12em;color:#9CA3AF;margin-bottom:8px">Payable Amount</p>
        <div id="event-payment-amount" style="font-size:34px;font-weight:900;color:#1F2937;letter-spacing:-0.03em">Rs.0.00</div>
        <p style="font-size:12px;color:#6B7280;font-weight:500;margin-top:8px">The same amount shown on the event card will be charged.</p>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <label style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:#9CA3AF;display:block;margin-bottom:6px">Card Number</label>
          <input type="text" value="4242 4242 4242 4242" readonly style="width:100%;padding:14px;border-radius:14px;border:2px solid #F3F4F6;background:#FAFAFA;font-size:12px;box-sizing:border-box;color:#4B5563">
        </div>
        <div>
          <label style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:#9CA3AF;display:block;margin-bottom:6px">Expiry</label>
          <input type="text" value="12/28" readonly style="width:100%;padding:14px;border-radius:14px;border:2px solid #F3F4F6;background:#FAFAFA;font-size:12px;box-sizing:border-box;color:#4B5563">
        </div>
      </div>
      <div style="margin-bottom:24px">
        <label style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:#9CA3AF;display:block;margin-bottom:6px">UPI / CVV</label>
        <input type="text" value="demo@upi / 123" readonly style="width:100%;padding:14px;border-radius:14px;border:2px solid #F3F4F6;background:#FAFAFA;font-size:12px;box-sizing:border-box;color:#4B5563">
      </div>
      <button onclick="processEventDummyPayment()" style="width:100%;padding:18px;border-radius:999px;background:linear-gradient(135deg,#D68D8D,#C07070);color:white;font-weight:800;font-size:13px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
        <span id="event-payment-button-label">Pay Now</span>
        <i class="fa-solid fa-lock"></i>
      </button>
      <p style="text-align:center;margin-top:14px;font-size:10px;color:#D1D5DB;font-weight:700;text-transform:uppercase;letter-spacing:.1em">
        Dummy checkout for demo purpose
      </p>
    </div>`;
  document.body.appendChild(modal);
}

function openEventPaymentModal(eventItem) {
  const user = requireAuth("Please login to pay for the event");
  if (!user) return;

  const amount = Number(eventItem.price || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast(`Joined successfully: ${eventItem.title}`, "success");
    return;
  }

  ensureEventPaymentModal();
  currentEventPayment = {
    id: eventItem.id,
    title: eventItem.title,
    amount,
  };

  document.getElementById("event-payment-title").textContent = eventItem.title;
  document.getElementById("event-payment-amount").textContent = `Rs.${amount.toFixed(2)}`;
  document.getElementById("event-payment-button-label").textContent = `Pay Rs.${amount.toFixed(2)}`;
  document.getElementById("event-payment-modal").classList.remove("hidden");
}

function closeEventPaymentModal() {
  const modal = document.getElementById("event-payment-modal");
  if (modal) modal.classList.add("hidden");
  currentEventPayment = null;
}

async function processEventDummyPayment() {
  if (!currentEventPayment) {
    showToast("Payment details are missing", "error");
    return;
  }

  const modal = document.getElementById("event-payment-modal");
  const payBtn = modal?.querySelector('button[onclick="processEventDummyPayment()"]');
  const restoreButton = setButtonLoading(
    payBtn,
    '<i class="fa-solid fa-spinner fa-spin"></i> Processing Payment...'
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    showToast(`Payment successful. You're in for ${currentEventPayment.title}!`, "success");
    closeEventPaymentModal();
  } catch (error) {
    showToast(error.message || "Payment failed", "error");
  } finally {
    restoreButton();
  }
}

async function loadEvents() {
  const container = getByAnyId(["eventsContainer", "events-list"]);
  if (!container) return;

  try {
    const localEvents = readCachedEvents();
    let events = [];

    try {
      const serverEvents = await fetchJson(`${API_BASE}/events`);
      const normalizedServerEvents = (Array.isArray(serverEvents) ? serverEvents : []).map(normalizeEventRecord);
      events = mergeEvents(normalizedServerEvents, localEvents).map(normalizeEventRecord);
      replaceCachedEventsForScope(events, "");
    } catch {
      events = mergeEvents([], localEvents).map(normalizeEventRecord);
    }

    loadedEvents = events;
    container.innerHTML = "";
    if (!events.length) {
      loadedEvents = [];
      container.innerHTML = `<div class="col-span-full text-center py-20"><i class="fa-solid fa-calendar-xmark text-5xl text-[#A8B5A2]/50 mb-4 block"></i><p class="text-gray-400 font-semibold">No events yet. Host one above!</p></div>`;
      return;
    }

    container.innerHTML = events.map((ev, index) => eventCardMarkup(ev, index)).join("");
  } catch (error) {
    console.error("Error rendering events:", error);
    container.innerHTML = `<p class="col-span-full text-center text-red-500 font-medium py-8 bg-red-50 rounded-xl">Failed to render events.</p>`;
  }
}

async function createFundraiser(event) {
  event.preventDefault();
  const user = requireAuth("You must be logged in to start a campaign");
  if (!user) return;

  try {
    const title = document.getElementById("fundraiser-title").value.trim();
    const target_amount = document.getElementById("fundraiser-target").value.trim();
    const description = document.getElementById("fundraiser-description").value.trim();
    const imageInput = document.getElementById("fundraiser-image-input");

    if (!title || !target_amount || !description) {
      showToast("Please complete all required fields", "error");
      return;
    }

    let image = "";
    if (imageInput?.files?.[0]) {
      image = await fileToDataUrl(imageInput.files[0]);
    }

    await fetchJson(`${API_BASE}/fundraisers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        target_amount,
        description,
        image,
        creator_id: user.id,
        createdBy: sanitizeCreatedBy(getDisplayName(user)) || "User",
      }),
    });

    event.target.reset();
    toggleImagePreview("fundraiser-create-preview");
    showToast("Campaign launched successfully", "success");
    loadFundraisers();
  } catch (error) {
    showToast(error.message || "Network error", "error");
  }
}

function fundraiserCardMarkup(f, index, userId) {
  const target = parseFloat(f.target_amount) || 1;
  const raised = parseFloat(f.raised_amount) || 0;
  const progress = Math.min(Math.round((raised / target) * 100), 100);
  const isCreator = userId && f.creator_id === userId;
  const safeTitle = escapeHtml(f.title);
  const safeDesc = escapeHtml(f.description);
  const safeImg = escapeHtml(f.image || "");

  const creatorBtns = isCreator ? `
    <div class="absolute top-4 right-4 flex gap-2">
      <button class="edit-fundraiser-btn w-9 h-9 bg-white/90 backdrop-blur shadow-sm rounded-full flex items-center justify-center text-gray-700 hover:bg-[#D68D8D] hover:text-white transition"
        data-fid="${escapeHtml(f.id)}" data-ftitle="${safeTitle}" data-ftarget="${escapeHtml(f.target_amount)}" data-fdesc="${safeDesc}" data-fimg="${safeImg}">
        <i class="fa-solid fa-pen-to-square text-sm"></i>
      </button>
      <button class="delete-fundraiser-btn w-9 h-9 bg-white/90 backdrop-blur shadow-sm rounded-full flex items-center justify-center text-gray-700 hover:bg-red-500 hover:text-white transition"
        data-fid="${escapeHtml(f.id)}">
        <i class="fa-solid fa-trash text-sm"></i>
      </button>
    </div>` : "";

  return `
    <div class="soft-card soft-shadow flex flex-col h-full overflow-hidden border border-[#D68D8D]/5 group" data-aos="fade-up" data-aos-delay="${index * 100}">
      <div class="relative h-56 img-wrapper">
        <img src="${escapeHtml(f.image || "https://images.unsplash.com/photo-1532629345422-7515f3d16bb6?auto=format&fit=crop&q=80&w=600")}" class="w-full h-full object-cover img-zoom">
        ${creatorBtns}
      </div>
      <div class="p-8 flex flex-col flex-grow">
        <h3 class="text-2xl font-serif font-black text-[#1F2937] mb-2 leading-tight">${safeTitle}</h3>
        <p class="text-[11px] font-bold uppercase tracking-[0.18em] text-[#D68D8D] mb-4">Created by: ${escapeHtml(sanitizeCreatedBy(f.createdBy) || "User")}</p>
        <p class="text-gray-400 text-sm font-medium mb-8 line-clamp-2 leading-relaxed h-11">${safeDesc}</p>
        <div class="mt-auto bg-[#F9F7F2] p-6 rounded-[24px] border border-[#D68D8D]/10">
          <div class="flex justify-between text-[11px] font-black uppercase tracking-widest mb-3">
            <span class="text-[#D68D8D]">Rs.${escapeHtml(f.raised_amount || 0)} Raised</span>
            <span class="text-gray-400">Target Rs.${escapeHtml(f.target_amount || 0)}</span>
          </div>
          <div class="w-full bg-white h-2 rounded-full mb-6">
            <div class="bg-[#D68D8D] h-2 rounded-full transition-all duration-1000" style="width: ${progress}%"></div>
          </div>
          <button onclick="contribute()" class="contribute-btn btn-soft w-full py-3 text-[10px] uppercase tracking-widest font-bold shadow-sm" data-fid="${escapeHtml(f.id)}" data-ftitle="${safeTitle}">
            Contribute
          </button>
        </div>
      </div>
    </div>
  `;
}

async function loadFundraisers() {
  const container = document.getElementById("fundraiser-list");
  if (!container) return;

  try {
    const fundraisers = (await fetchJson(`${API_BASE}/fundraisers`)).map((item) => ({
      ...item,
      createdBy: sanitizeCreatedBy(item.createdBy) || "User",
    }));
    const userId = getCurrentUser()?.id || null;

    if (!fundraisers.length) {
      container.innerHTML = `<div class="col-span-full text-center py-20"><i class="fa-solid fa-hand-holding-heart text-5xl text-[#D68D8D]/30 mb-4 block"></i><p class="text-gray-400 font-semibold">No campaigns yet. Launch one above!</p></div>`;
      return;
    }

    container.innerHTML = fundraisers.map((item, index) => fundraiserCardMarkup(item, index, userId)).join("");
  } catch (error) {
    console.error("Error loading fundraisers:", error);
    container.innerHTML = `<p class="col-span-full text-center text-red-500 font-medium py-8 bg-red-50 rounded-xl">Failed to load fundraisers.</p>`;
  }
}

function _ensurePaymentModal() {
  if (document.getElementById("payment-modal")) return;

  const modal = document.createElement("div");
  modal.id = "payment-modal";
  modal.className = "hidden fixed inset-0 z-[100] flex items-center justify-center px-4";
  modal.style.cssText = "background:rgba(0,0,0,0.35);backdrop-filter:blur(8px)";
  modal.innerHTML = `
    <div style="background:#fff;border-radius:40px;padding:44px 40px;max-width:440px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,0.15);position:relative;overflow:hidden;font-family:'Plus Jakarta Sans',sans-serif">
      <div style="position:absolute;top:0;left:0;width:100%;height:4px;background:linear-gradient(90deg,#D68D8D,#A8B5A2)"></div>
      <button onclick="closePaymentModal()" style="position:absolute;top:20px;right:20px;background:none;border:none;font-size:20px;color:#9CA3AF;cursor:pointer"><i class="fa-solid fa-xmark"></i></button>
      <div style="text-align:center;margin-bottom:28px">
        <div style="width:56px;height:56px;border-radius:50%;background:#FFF0F0;margin:0 auto 12px;display:flex;align-items:center;justify-content:center">
          <i class="fa-solid fa-shield-heart" style="color:#D68D8D;font-size:22px"></i>
        </div>
        <h2 style="font-size:22px;font-weight:900;color:#1F2937;margin-bottom:6px">Secure Contribution</h2>
        <p style="font-size:13px;color:#9CA3AF;font-weight:500">You are supporting <span id="payment-title" style="color:#D68D8D;font-weight:700">this cause</span></p>
      </div>
      <div style="margin-bottom:24px">
        <label style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:#9CA3AF;display:block;margin-bottom:6px">Contribution Amount (Rs.)</label>
        <input type="number" id="payment-amount" placeholder="500" style="width:100%;padding:16px;border-radius:16px;border:2px solid #F3F4F6;outline:none;font-size:20px;font-weight:700;color:#1F2937;box-sizing:border-box">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px;opacity:.5">
        <div>
          <label style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:#9CA3AF;display:block;margin-bottom:6px">Card Number</label>
          <input type="text" placeholder="4242 4242 4242 4242" disabled style="width:100%;padding:14px;border-radius:14px;border:2px solid #F3F4F6;background:#FAFAFA;font-size:12px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:#9CA3AF;display:block;margin-bottom:6px">Expiry</label>
          <input type="text" placeholder="12/28" disabled style="width:100%;padding:14px;border-radius:14px;border:2px solid #F3F4F6;background:#FAFAFA;font-size:12px;box-sizing:border-box">
        </div>
      </div>
      <button onclick="processDummyPayment()" style="width:100%;padding:18px;border-radius:50px;background:linear-gradient(135deg,#D68D8D,#C07070);color:white;font-weight:800;font-size:13px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
        <span>Complete Contribution</span><i class="fa-solid fa-arrow-right"></i>
      </button>
      <p style="text-align:center;margin-top:16px;font-size:10px;color:#D1D5DB;font-weight:700;text-transform:uppercase;letter-spacing:.1em">
        <i class="fa-solid fa-lock"></i> Encrypted Dummy Transaction
      </p>
    </div>`;
  document.body.appendChild(modal);
}

function openPaymentModal(id, title) {
  const user = requireAuth("Please login to contribute");
  if (!user) return;

  _ensurePaymentModal();
  currentPaymentId = id;
  document.getElementById("payment-title").innerText = title;
  document.getElementById("payment-modal").classList.remove("hidden");
}

function closePaymentModal() {
  const modal = document.getElementById("payment-modal");
  if (modal) modal.classList.add("hidden");
  currentPaymentId = null;
}

async function processDummyPayment() {
  const amount = parseFloat(document.getElementById("payment-amount").value);
  if (!amount || amount <= 0) {
    showToast("Please enter a valid amount", "error");
    return;
  }

  const modal = document.getElementById("payment-modal");
  const payBtn = modal.querySelector('button[onclick="processDummyPayment()"]');
  const restoreButton = setButtonLoading(payBtn, '<i class="fa-solid fa-spinner fa-spin"></i> Processing...');

  try {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await fetchJson(`${API_BASE}/fundraisers/${currentPaymentId}/contribute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    showToast("Payment successful. Contribution recorded.", "success");
    closePaymentModal();
    loadFundraisers();
  } catch (error) {
    showToast(error.message || "Payment failed", "error");
  } finally {
    restoreButton();
  }
}

document.addEventListener("click", (event) => {
  const contributeBtn = event.target.closest(".contribute-btn");
  if (contributeBtn) {
    return;
  }

  const editFundBtn = event.target.closest(".edit-fundraiser-btn");
  if (editFundBtn) {
    openEditFundraiser(
      editFundBtn.dataset.fid,
      editFundBtn.dataset.ftitle,
      editFundBtn.dataset.ftarget,
      editFundBtn.dataset.fdesc,
      editFundBtn.dataset.fimg,
    );
    return;
  }

  const delFundBtn = event.target.closest(".delete-fundraiser-btn");
  if (delFundBtn) {
    deleteFundraiser(delFundBtn.dataset.fid);
  }
});

function openEditFundraiser(id, title, target, desc, image) {
  currentEditFundraiserId = id;
  document.getElementById("edit-fundraiser-title").value = title;
  document.getElementById("edit-fundraiser-target").value = target;
  document.getElementById("edit-fundraiser-description").value = desc;
  toggleImagePreview("edit-fundraiser-preview", image && image !== "undefined" && image !== "null" ? image : "");
  document.getElementById("edit-fundraiser-modal").classList.remove("hidden");
}

async function updateFundraiser(event) {
  event.preventDefault();
  const user = requireAuth("Please login to edit your fundraiser");
  if (!user) return;

  try {
    const title = document.getElementById("edit-fundraiser-title").value.trim();
    const target_amount = document.getElementById("edit-fundraiser-target").value.trim();
    const description = document.getElementById("edit-fundraiser-description").value.trim();
    const imageInput = document.getElementById("edit-fundraiser-image-input");

    const payload = { title, target_amount, description, user_id: user.id };
    if (imageInput?.files?.[0]) {
      payload.image = await fileToDataUrl(imageInput.files[0]);
    }

    await fetchJson(`${API_BASE}/fundraisers/${currentEditFundraiserId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    document.getElementById("edit-fundraiser-modal").classList.add("hidden");
    showToast("Fundraiser updated", "success");
    loadFundraisers();
  } catch (error) {
    showToast(error.message || "Update failed", "error");
  }
}

async function deleteFundraiser(id) {
  showConfirmModal("Are you sure you want to delete this campaign? This cannot be undone.", async () => {
    const user = requireAuth("Please login to delete your fundraiser");
    if (!user) return;

    try {
      await fetchJson(`${API_BASE}/fundraisers/${id}?user_id=${user.id}`, { method: "DELETE" });
      showToast("Campaign removed", "success");
      loadFundraisers();
    } catch (error) {
      showToast(error.message || "Delete failed", "error");
    }
  });
}

function previewFundraiserCreate(event) {
  const file = event.target.files?.[0];
  if (!file) {
    toggleImagePreview("fundraiser-create-preview");
    return;
  }
  const reader = new FileReader();
  reader.onload = (loadEvent) => toggleImagePreview("fundraiser-create-preview", loadEvent.target.result);
  reader.readAsDataURL(file);
}

function previewFundraiserEdit(event) {
  const file = event.target.files?.[0];
  if (!file) {
    toggleImagePreview("edit-fundraiser-preview");
    return;
  }
  const reader = new FileReader();
  reader.onload = (loadEvent) => toggleImagePreview("edit-fundraiser-preview", loadEvent.target.result);
  reader.readAsDataURL(file);
}

function getQueryParam(param) {
  const urlParams = new URLSearchParams(window.location.search);
  let value = urlParams.get(param);
  if (!value && param === "id") {
    const pathParts = window.location.pathname.split("/");
    if (pathParts.includes("community")) {
      value = pathParts[pathParts.indexOf("community") + 1];
    }
  }
  return value;
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.remove("active", "border-[#8B5CF6]", "text-[#8B5CF6]");
    btn.classList.add("border-transparent", "text-gray-400");
  });

  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.add("hidden");
    content.classList.remove("block", "flex");
  });

  const activeBtn = document.getElementById(`tab-${tabId}`);
  if (activeBtn) {
    activeBtn.classList.add("active", "border-[#8B5CF6]", "text-[#8B5CF6]");
    activeBtn.classList.remove("border-transparent", "text-gray-400");
  }

  const activeContent = document.getElementById(`content-${tabId}`);
  if (activeContent) {
    activeContent.classList.remove("hidden");
    activeContent.classList.add(tabId === "posts" ? "block" : "flex");
    if (tabId === "chat") {
      const chatFeed = document.getElementById("chat-feed");
      if (chatFeed) chatFeed.scrollTop = chatFeed.scrollHeight;
    }
  }
}

async function loadCommunityDetails() {
  const id = getQueryParam("id");
  if (!id || id === "community") {
    window.location.href = "/communities";
    return;
  }

  try {
    const comm = await fetchJson(`${API_BASE}/communities/${id}`);
    const detailCreatedBy = document.getElementById("detail-created-by");

    document.getElementById("detail-name").innerText = comm.name;
    document.getElementById("detail-category").innerText = comm.category;
    document.getElementById("detail-desc").innerText = comm.description;
    document.getElementById("detail-members").innerHTML = `<i class="fa-solid fa-user-group text-[#C8B6FF]"></i> <span>${comm.members} Members</span>`;
    if (comm.image) document.getElementById("detail-banner").src = comm.image;
    if (detailCreatedBy) detailCreatedBy.innerText = `Created by: ${sanitizeCreatedBy(comm.createdBy) || "User"}`;

    const userId = getCurrentUser()?.id || null;
    const isMember = Array.isArray(comm.members_list) && comm.members_list.includes(userId);
    const joinBtn = document.getElementById("detail-join-btn");

    if (userId && userId === comm.creator_id) {
      document.getElementById("creator-controls")?.classList.remove("hidden");
      document.getElementById("creator-controls")?.classList.add("flex");
      document.getElementById("edit-community-name").value = comm.name;
      document.getElementById("edit-community-category").value = comm.category;
      document.getElementById("edit-community-description").value = comm.description;
    }

    if (isMember) {
      joinBtn.innerText = "Leave Community";
      joinBtn.classList.replace("btn-soft", "btn-outline-lilac");
      document.getElementById("access-gateway")?.classList.add("hidden");
      document.getElementById("access-gateway")?.classList.remove("flex");
      document.getElementById("unlocked-content")?.classList.remove("hidden");
      document.getElementById("unlocked-content")?.classList.add("flex");
      loadPosts(id);
      loadChat(id);
      loadCommunityEvents(id);
      if (communityChatPoller) clearInterval(communityChatPoller);
      communityChatPoller = setInterval(() => loadChat(id, false), 5000);
    } else {
      joinBtn.innerText = "Join Community";
      joinBtn.classList.replace("btn-outline-lilac", "btn-soft");
      document.getElementById("access-gateway")?.classList.remove("hidden");
      document.getElementById("access-gateway")?.classList.add("flex");
      document.getElementById("unlocked-content")?.classList.add("hidden");
      document.getElementById("unlocked-content")?.classList.remove("flex");
    }
  } catch (error) {
    showToast(error.message || "Error loading community", "error");
  }
}

async function toggleJoinCommunity() {
  const id = getQueryParam("id");
  const user = requireAuth("Please login to join communities");
  if (!user) {
    setTimeout(() => { window.location.href = "/login"; }, 400);
    return;
  }

  try {
    await fetchJson(`${API_BASE}/communities/${id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id }),
    });
    window.location.reload();
  } catch (error) {
    showToast(error.message || "Could not update membership", "error");
  }
}

async function deleteCommunity() {
  showConfirmModal("Are you sure you want to permanently delete this community? This cannot be undone.", async () => {
    const id = getQueryParam("id");
    const user = requireAuth("Please login to delete your community");
    if (!user) return;

    try {
      await fetchJson(`${API_BASE}/communities/${id}?user_id=${user.id}`, { method: "DELETE" });
      showToast("Community completely removed", "success");
      setTimeout(() => { window.location.href = "/communities"; }, 1200);
    } catch (error) {
      showToast(error.message || "Failed to delete community", "error");
    }
  });
}

async function updateCommunity(event) {
  event.preventDefault();
  const id = getQueryParam("id");
  const user = requireAuth("Please login to edit your community");
  if (!user) return;

  try {
    const name = document.getElementById("edit-community-name").value.trim();
    const category = document.getElementById("edit-community-category").value.trim();
    const description = document.getElementById("edit-community-description").value.trim();
    const imageInput = document.getElementById("edit-community-image");
    const payload = { name, category, description, user_id: user.id };

    if (imageInput?.files?.[0]) {
      payload.image = await fileToDataUrl(imageInput.files[0]);
    }

    await fetchJson(`${API_BASE}/communities/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    document.getElementById("edit-community-modal").classList.add("hidden");
    showToast("Community details updated", "success");
    loadCommunityDetails();
  } catch (error) {
    showToast(error.message || "Update failed", "error");
  }
}

function previewPostImage(event) {
  const file = event.target.files?.[0];
  if (!file) {
    toggleImagePreview("post-image-preview");
    return;
  }
  const reader = new FileReader();
  reader.onload = (loadEvent) => toggleImagePreview("post-image-preview", loadEvent.target.result);
  reader.readAsDataURL(file);
}

function clearPostImage() {
  const input = document.getElementById("post-image-input");
  if (input) input.value = "";
  toggleImagePreview("post-image-preview");
}

function previewEditImage(event) {
  const file = event.target.files?.[0];
  if (!file) {
    toggleImagePreview("edit-image-preview");
    return;
  }
  const reader = new FileReader();
  reader.onload = (loadEvent) => toggleImagePreview("edit-image-preview", loadEvent.target.result);
  reader.readAsDataURL(file);
}

function previewCreateImage(event) {
  const file = event.target.files?.[0];
  if (!file) {
    toggleImagePreview("create-image-preview");
    return;
  }
  const reader = new FileReader();
  reader.onload = (loadEvent) => toggleImagePreview("create-image-preview", loadEvent.target.result);
  reader.readAsDataURL(file);
}

async function loadPosts(communityId) {
  try {
    const posts = await fetchJson(`${API_BASE}/communities/${communityId}/posts`);
    const feed = document.getElementById("posts-feed");
    if (!feed) return;

    if (!posts.length) {
      feed.innerHTML = `<p class="text-center text-gray-400 py-8">No posts yet. Start the conversation!</p>`;
      return;
    }

    feed.innerHTML = posts.map((post) => `
      <div class="glass-panel p-6 rounded-2xl shadow-sm">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-[#8B5CF6] to-[#22C55E] flex items-center justify-center text-white font-bold text-sm shadow-sm">${escapeHtml((post.userName || "M").charAt(0).toUpperCase())}</div>
          <div>
            <p class="font-bold text-[#1F2937] text-sm">${escapeHtml(post.userName)}</p>
            <p class="text-xs text-gray-400">${escapeHtml(post.createdAt)}</p>
          </div>
        </div>
        <p class="text-gray-600 text-sm leading-relaxed mb-4">${escapeHtml(post.content)}</p>
        ${post.image ? `<div class="w-full max-h-[400px] rounded-xl overflow-hidden mb-4 border border-[#E6DFFF]"><img src="${escapeHtml(post.image)}" class="w-full h-full object-cover"></div>` : ""}
        <div class="flex items-center gap-6 text-gray-400 text-xs font-semibold">
          <button class="hover:text-[#8B5CF6] transition"><i class="fa-regular fa-heart"></i> Like</button>
          <button class="hover:text-[#8B5CF6] transition"><i class="fa-regular fa-comment"></i> Comment</button>
        </div>
      </div>
    `).join("");
  } catch (error) {
    console.error(error);
  }
}

async function submitPost(event) {
  event.preventDefault();
  const user = requireAuth("Please login to post in the community");
  if (!user) return;

  const id = getQueryParam("id");
  const content = document.getElementById("post-input").value.trim();
  const imageInput = document.getElementById("post-image-input");

  if (!content) {
    showToast("Please write something before posting", "error");
    return;
  }

  try {
    let image = null;
    if (imageInput?.files?.[0]) {
      image = await fileToDataUrl(imageInput.files[0]);
    }

    await fetchJson(`${API_BASE}/communities/${id}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id, user_name: getDisplayName(user), content, image }),
    });

    document.getElementById("post-input").value = "";
    clearPostImage();
    loadPosts(id);
  } catch (error) {
    showToast(error.message || "Failed to post", "error");
  }
}

async function loadChat(communityId, scroll = true) {
  try {
    const messages = await fetchJson(`${API_BASE}/communities/${communityId}/messages`);
    const feed = document.getElementById("chat-feed");
    if (!feed) return;

    const user = getCurrentUser() || {};
    const html = !messages.length
      ? `<p class="text-center text-gray-400 py-12 m-auto">No messages yet. Say hi!</p>`
      : messages.map((msg) => {
          const isMe = msg.userId === user.id;
          return `
            <div class="flex w-full ${isMe ? "justify-end" : "justify-start"}">
              <div class="max-w-[75%]">
                ${!isMe ? `<p class="text-xs text-gray-400 mb-1 ml-1">${escapeHtml(msg.userName)}</p>` : ""}
                <div class="${isMe ? "bg-[#8B5CF6] text-white rounded-l-2xl rounded-tr-2xl" : "bg-white text-[#1F2937] border border-[#E6DFFF] rounded-r-2xl rounded-tl-2xl"} p-3 shadow-sm text-sm">
                  ${escapeHtml(msg.message)}
                </div>
                <p class="text-[10px] text-gray-400 mt-1 ${isMe ? "text-right mr-1" : "ml-1"}">${escapeHtml(msg.timestamp)}</p>
              </div>
            </div>
          `;
        }).join("");

    if (feed.innerHTML !== html) {
      feed.innerHTML = html;
      if (scroll) feed.scrollTop = feed.scrollHeight;
    }
  } catch (error) {
    console.error(error);
  }
}

async function sendChatMessage(event) {
  event.preventDefault();
  const user = requireAuth("Please login to chat");
  if (!user) return;

  const id = getQueryParam("id");
  const input = document.getElementById("chat-input");
  const message = input.value.trim();

  if (!message) {
    showToast("Please type a message", "error");
    return;
  }

  try {
    await fetchJson(`${API_BASE}/communities/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id, user_name: getDisplayName(user), message }),
    });
    input.value = "";
    loadChat(id, true);
  } catch (error) {
    showToast(error.message || "Failed to send message", "error");
  }
}

async function submitCommunityEvent(event) {
  event.preventDefault();
  const user = requireAuth("Please login before publishing a community event");
  if (!user) return;

  const id = getQueryParam("id");
  const title = document.getElementById("ce-title").value.trim();
  const date = document.getElementById("ce-date").value.trim();
  const location = document.getElementById("ce-loc").value.trim();
  const description = document.getElementById("ce-desc").value.trim();

  if (!title || !date || !location || !description) {
    showToast("Please complete all event fields", "error");
    return;
  }

  try {
    const draft = buildEventPayload({ title, date, location, description, image: "", communityId: id }, user);
    upsertCachedEvent(draft);
    await loadCommunityEvents(id);

    try {
      const data = await fetchJson(`${API_BASE}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          date,
          location,
          description,
          image: "",
          communityId: id,
          creator_id: user.id,
          createdBy: sanitizeCreatedBy(getDisplayName(user)) || "User",
          createdAt: draft.createdAt,
        }),
      });
      upsertCachedEvent(data.event || draft, draft.id);
    } catch {
      // Keep local event if backend write fails.
    }

    event.target.reset();
    document.getElementById("create-event-modal").classList.add("hidden");
    showToast("Event created successfully", "success");
    loadCommunityEvents(id);
  } catch (error) {
    showToast(error.message || "Failed to host event", "error");
  }
}

async function loadCommunityEvents(communityId) {
  try {
    const localEvents = readCachedEvents();
    let events = [];

    try {
      const serverEvents = await fetchJson(`${API_BASE}/events?communityId=${communityId}`);
      events = mergeEvents(serverEvents, localEvents, communityId);
      replaceCachedEventsForScope(events, communityId);
    } catch {
      events = mergeEvents([], localEvents, communityId);
    }

    const feed = document.getElementById("community-events-list");
    if (!feed) return;

    if (!events.length) {
      feed.innerHTML = `<p class="col-span-full text-center text-gray-400 py-8">No localized events yet.</p>`;
      return;
    }

    feed.innerHTML = events.map((ev) => `
      <div class="glass-panel p-5 rounded-2xl shadow-sm border-l-4 border-l-[#22C55E]">
        <p class="text-[#22C55E] text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-1.5">
          <i class="fa-regular fa-calendar"></i> ${escapeHtml(ev.date)}
        </p>
        <h3 class="text-lg font-bold font-poppins text-[#1F2937] mb-1 leading-tight">${escapeHtml(ev.title)}</h3>
        <p class="text-[11px] font-bold uppercase tracking-[0.18em] text-[#D68D8D] mb-3">Created by: ${escapeHtml(sanitizeCreatedBy(ev.createdBy) || "User")}</p>
        <p class="text-gray-500 text-xs mb-3 flex items-center gap-1"><i class="fa-solid fa-location-dot text-[#8B5CF6]"></i> ${escapeHtml(ev.location)}</p>
        <p class="text-gray-500 text-sm line-clamp-2 leading-relaxed">${escapeHtml(ev.description)}</p>
      </div>
    `).join("");
  } catch (error) {
    console.error(error);
  }
}

async function loadProfilePage() {
  const user = requireAuth("Please login to view your profile");
  if (!user) {
    setTimeout(() => { window.location.href = "/login"; }, 400);
    return;
  }

  let profile = user;
  try {
    profile = normalizeUser(await fetchJson(`${API_BASE}/profile/${user.id}`)) || user;
    saveCurrentUser(profile);
  } catch {
    profile = getCurrentUser() || user;
  }

  renderProfile(profile);
}

function renderProfile(profile) {
  const avatar = document.getElementById("profile-avatar");
  const fallbackAvatar = document.getElementById("profile-avatar-fallback");
  const name = document.getElementById("profile-name");
  const username = document.getElementById("profile-username");
  const email = document.getElementById("profile-email");
  const phone = document.getElementById("profile-phone");
  const interests = document.getElementById("profile-interests");
  const emptyState = document.getElementById("profile-empty-interests");

  const initials = getDisplayName(profile).slice(0, 1).toUpperCase();
  if (avatar) avatar.src = profile.profilePic || "";
  if (avatar) avatar.classList.toggle("hidden", !profile.profilePic);
  if (fallbackAvatar) {
    fallbackAvatar.textContent = initials;
    fallbackAvatar.classList.toggle("hidden", Boolean(profile.profilePic));
  }

  if (name) name.textContent = getDisplayName(profile);
  if (username) username.textContent = `@${profile.username}`;
  if (email) email.textContent = profile.email || "Not added yet";
  if (phone) phone.textContent = profile.phone || "Not added yet";

  if (interests) {
    interests.innerHTML = "";
    if (profile.interests?.length) {
      profile.interests.forEach((item) => {
        const chip = document.createElement("span");
        chip.className = "profile-chip";
        chip.textContent = item;
        interests.appendChild(chip);
      });
      if (emptyState) emptyState.classList.add("hidden");
    } else if (emptyState) {
      emptyState.classList.remove("hidden");
    }
  }

  document.getElementById("profile-form-username").value = profile.username || "";
  document.getElementById("profile-form-email").value = profile.email || "";
  document.getElementById("profile-form-phone").value = profile.phone || "";
  document.getElementById("profile-form-interests").value = (profile.interests || []).join(", ");
  toggleImagePreview("profile-upload-preview", profile.profilePic || "");
}

function openProfileEditor() {
  document.getElementById("profile-edit-panel")?.classList.remove("hidden");
}

function closeProfileEditor() {
  document.getElementById("profile-edit-panel")?.classList.add("hidden");
}

function previewProfileImage(event) {
  const file = event.target.files?.[0];
  if (!file) {
    toggleImagePreview("profile-upload-preview");
    return;
  }
  const reader = new FileReader();
  reader.onload = (loadEvent) => toggleImagePreview("profile-upload-preview", loadEvent.target.result);
  reader.readAsDataURL(file);
}

async function saveProfile(event) {
  event.preventDefault();
  const currentUser = requireAuth("Please login to update your profile");
  if (!currentUser) return;

  const submitButton = event.target.querySelector("button[type='submit'], button:not([type])");
  const restoreButton = setButtonLoading(submitButton, '<i class="fa-solid fa-spinner fa-spin"></i> Saving...');

  try {
    const username = document.getElementById("profile-form-username").value.trim();
    const email = document.getElementById("profile-form-email").value.trim();
    const phone = document.getElementById("profile-form-phone").value.trim();
    const interests = document.getElementById("profile-form-interests").value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (!username) {
      showToast("Username is required", "error");
      return;
    }

    let profilePic = getCurrentUser()?.profilePic || "";
    const imageInput = document.getElementById("profile-form-image");
    if (imageInput?.files?.[0]) {
      profilePic = await fileToDataUrl(imageInput.files[0]);
    }

    const data = await fetchJson(`${API_BASE}/profile/${currentUser.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, phone, profilePic, interests }),
    });

    saveCurrentUser(data.user);
    renderProfile(normalizeUser(data.user));
    renderAuthState();
    closeProfileEditor();
    showToast("Profile updated successfully", "success");
  } catch (error) {
    showToast(error.message || "Failed to update profile", "error");
  } finally {
    restoreButton();
  }
}

function renderAuthState() {
  const authNav = document.getElementById("nav-auth-state");
  const mobileAuthNav = document.getElementById("mobile-nav-auth");
  const user = getCurrentUser();

  if (!authNav && !mobileAuthNav) return;

  if (!user) {
    const guestHtml = `<a href="/login" class="btn-soft px-7 py-2.5 ml-4 text-xs">Login</a>`;
    if (authNav) authNav.innerHTML = guestHtml;
    if (mobileAuthNav) mobileAuthNav.innerHTML = `<a href="/login" class="btn-soft px-10 py-4 text-sm">Login</a>`;
    return;
  }

  const firstName = getDisplayName(user).split(" ")[0];
  const desktopHtml = `
    <div class="flex items-center gap-3 ml-4">
      <a href="/profile" class="text-sm font-semibold text-[#D68D8D] hover:text-[#C07070] transition">Hi, ${escapeHtml(firstName)}</a>
      <a href="/profile" class="btn-outline-lilac px-4 py-1.5 text-xs">Profile</a>
      <button onclick="logoutUser()" class="btn-outline-lilac px-4 py-1.5 text-xs">Logout</button>
    </div>`;
  const mobileHtml = `
    <div class="flex flex-col items-center gap-4">
      <a href="/profile" class="text-lg font-serif font-black text-[#D68D8D]">Hi, ${escapeHtml(firstName)}</a>
      <a href="/profile" class="btn-outline-lilac px-10 py-3 text-sm">Profile</a>
      <button onclick="logoutUser()" class="btn-soft px-10 py-3 text-sm">Logout</button>
    </div>`;

  if (authNav) authNav.innerHTML = desktopHtml;
  if (mobileAuthNav) mobileAuthNav.innerHTML = mobileHtml;
}

function setupMobileMenu() {
  const mobileBtn = document.getElementById("mobile-menu-btn");
  const closeBtn = document.getElementById("close-menu-btn");
  const mobileMenu = document.getElementById("mobile-menu");

  if (mobileBtn && mobileMenu) {
    mobileBtn.addEventListener("click", () => {
      mobileMenu.classList.remove("hidden");
      document.body.style.overflow = "hidden";
    });
  }

  if (closeBtn && mobileMenu) {
    closeBtn.addEventListener("click", () => {
      mobileMenu.classList.add("hidden");
      document.body.style.overflow = "";
    });
  }
}

function setupEventForm() {
  const eventForm = document.getElementById("eventForm");
  if (!eventForm || eventForm.dataset.bound === "true") return;

  eventForm.dataset.bound = "true";
  eventForm.addEventListener("submit", createEvent);
  syncEventEditorUi();
}

document.addEventListener("DOMContentLoaded", async () => {
  await syncCurrentUserProfile();
  renderAuthState();
  setupMobileMenu();
  setupEventForm();

  const path = window.location.pathname;
  if (path.includes("/community/")) {
    loadCommunityDetails();
  } else if (path === "/profile" || path.endsWith("profile.html")) {
    loadProfilePage();
  } else if (path === "/" || path === "/home" || path.endsWith("index.html")) {
    loadCommunities();
    loadEvents();
    loadFundraisers();
  } else if (path.includes("/communities")) {
    loadCommunities();
  } else if (path.includes("/events")) {
    loadEvents();
  } else if (path.includes("/fundraisers")) {
    loadFundraisers();
  }

  if (typeof AOS !== "undefined") {
    AOS.init({
      duration: 600,
      once: true,
      offset: 50,
    });
  }
});
