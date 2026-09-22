// src/ban.js
// Регистрация устройства/никнейма и проверка блокировки.
// Подключается в script.js перед initApp().

const DEVICE_ID_KEY = "plbt_device_id";
const NICKNAME_KEY = "plbt_nickname";
const RECHECK_INTERVAL_MS = 2 * 60 * 1000; // перепроверка каждые 2 минуты, пока вкладка открыта

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getStoredNickname() {
  return localStorage.getItem(NICKNAME_KEY) || "";
}

function setStoredNickname(nick) {
  localStorage.setItem(NICKNAME_KEY, nick);
}

function showBanScreen(reason) {
  const el = document.getElementById("ban-screen");
  if (!el) {
    // Отказоустойчивость: если разметка почему-то не найдена, всё равно блокируем работу.
    document.body.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b101d;color:#f87171;font-family:sans-serif;text-align:center;padding:20px;">Доступ заблокирован. ${reason || ""}</div>`;
    return;
  }
  const reasonEl = document.getElementById("ban-screen-reason");
  if (reasonEl) reasonEl.textContent = reason || "Причина не указана.";
  el.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function hideBanScreen() {
  const el = document.getElementById("ban-screen");
  if (el) el.style.display = "none";
  document.body.style.overflow = "";
}

function askNickname() {
  return new Promise((resolve) => {
    const modal = document.getElementById("nickname-modal");
    const input = document.getElementById("nickname-input");
    const btn = document.getElementById("nickname-submit-btn");
    const errorEl = document.getElementById("nickname-error");

    if (!modal || !input || !btn) {
      // Разметка не добавлена — не блокируем запуск приложения, просто даём случайный ник.
      resolve("Trader" + Math.floor(Math.random() * 100000));
      return;
    }

    modal.style.display = "flex";
    input.value = "";
    if (errorEl) errorEl.style.display = "none";

    function submit() {
      const val = input.value.trim();
      if (val.length < 3 || val.length > 20) {
        if (errorEl) {
          errorEl.textContent = "Никнейм должен быть от 3 до 20 символов.";
          errorEl.style.display = "block";
        }
        return;
      }
      cleanup();
      modal.style.display = "none";
      resolve(val);
    }
    function onKeydown(e) {
      if (e.key === "Enter") submit();
    }
    function cleanup() {
      btn.removeEventListener("click", submit);
      input.removeEventListener("keydown", onKeydown);
    }

    btn.addEventListener("click", submit);
    input.addEventListener("keydown", onKeydown);
    setTimeout(() => input.focus(), 50);
  });
}

async function callCheckBan(deviceId, nickname) {
  const res = await fetch("/api/check-ban", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, nickname }),
  });
  if (!res.ok) throw new Error("bad status " + res.status);
  return res.json();
}

/**
 * Инициализирует систему бана. Вызывать первым делом при загрузке страницы.
 * Возвращает true, если можно продолжать инициализацию приложения (не забанен),
 * и false, если нужно остановиться (показан экран блокировки).
 */
export async function initBanSystem() {
  const deviceId = getDeviceId();
  let nickname = getStoredNickname();

  if (!nickname) {
    nickname = await askNickname();
    setStoredNickname(nickname);
  }

  // Выставляем ник в профиле, если элементы уже в DOM.
  const profileTitle = document.getElementById("profile-user-title");
  if (profileTitle) profileTitle.textContent = nickname;
  const idDisplay = document.getElementById("profile-user-device-id");
  if (idDisplay) idDisplay.textContent = deviceId;

  try {
    const result = await callCheckBan(deviceId, nickname);
    if (result.banned) {
      showBanScreen(result.reason);
      return false;
    }
  } catch (e) {
    // Если сервер бана недоступен (например, оффлайн-режим приложения),
    // не блокируем работу — просто логируем.
    console.warn("[BanSystem] Проверка бана не удалась, продолжаем без неё:", e);
  }

  hideBanScreen();

  // Периодическая перепроверка, пока вкладка открыта — на случай, если пользователя забанили "на лету".
  setInterval(async () => {
    try {
      const r = await callCheckBan(getDeviceId(), getStoredNickname());
      if (r.banned) showBanScreen(r.reason);
    } catch (e) {
      // тихо игнорируем сетевые ошибки при фоновой проверке
    }
  }, RECHECK_INTERVAL_MS);

  return true;
}

export { getDeviceId };
