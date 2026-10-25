'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const screens = ['chat', 'conversation', 'search', 'tools', 'profile'];
let activeScreen = 'chat';
let activeSearchKind = 'internet';
let toastTimer;
let pendingChatTitle = '';
const chatHistory = [];

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2900);
}

function navigate(screen, options = {}) {
  if (!screens.includes(screen)) screen = 'chat';
  activeScreen = screen;
  $$('.screen').forEach((el) => el.classList.toggle('active', el.dataset.screen === screen));
  $$('.nav-item').forEach((el) => {
    const selected = el.dataset.go === (screen === 'conversation' ? 'chat' : screen);
    el.classList.toggle('active', selected);
    if (selected) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  closeDrawer();
  if (options.hash !== false) {
    const hash = screen === 'conversation' ? 'chat' : screen;
    historyReplace(hash);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (screen === 'conversation' && options.focus) setTimeout(() => $('#messageInput').focus(), 100);
}

function historyReplace(hash) {
  try { window.history.replaceState(null, '', `#${hash}`); } catch { /* Embedded preview */ }
}

function openDrawer() {
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawerBackdrop').hidden = false;
  $('#menuToggle').setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#drawerBackdrop').hidden = true;
  $('#menuToggle').setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}

function beginPrompt(prompt) {
  navigate('conversation', { focus: true });
  const input = $('#messageInput');
  input.value = prompt || '';
  resizeTextarea(input);
}

function resizeTextarea(element) {
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 128)}px`;
}

function formatTime() {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}

function addMessage(role, content) {
  const messages = $('#messages');
  const empty = $('.empty-chat', messages);
  if (empty) empty.remove();
  const item = document.createElement('article');
  item.className = `message ${role}`;
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = content;
  const meta = document.createElement('span');
  meta.className = 'message-meta';
  meta.textContent = formatTime();
  item.append(bubble, meta);
  messages.append(item);
  messages.scrollTop = messages.scrollHeight;
  return item;
}

function addHistory(title) {
  const normalized = title.trim().slice(0, 48) || 'Новый чат';
  chatHistory.unshift(normalized);
  const list = $('#historyList');
  list.replaceChildren();
  chatHistory.slice(0, 8).forEach((itemTitle, index) => {
    const button = document.createElement('button');
    button.className = 'history-item';
    button.type = 'button';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-1 2v-5.2A7.5 7.5 0 1 1 20 11.5Z');
    icon.append(path);
    const title = document.createElement('span');
    title.textContent = itemTitle;
    button.append(icon, title);
    button.addEventListener('click', () => showToast(`«${itemTitle}» — история пока хранится только в этом сеансе.`));
    list.append(button);
  });
}

async function sendMessage(text) {
  const content = text.trim();
  if (!content) return;
  if (content.length > 12000) { showToast('Сообщение слишком длинное. Максимум — 12 000 символов.'); return; }
  $('#messageInput').value = '';
  resizeTextarea($('#messageInput'));
  $('#conversationTitle').textContent = content.length > 32 ? `${content.slice(0, 32)}…` : content;
  if (!pendingChatTitle) {
    pendingChatTitle = content;
    addHistory(content);
  }
  addMessage('user', content);
  const button = $('.send-button');
  button.disabled = true;
  const waiting = addMessage('assistant', 'Проверяю подключение PHANTOM…');
  try {
    if (location.hostname.endsWith('github.io')) {
      waiting.querySelector('.message-bubble').textContent = 'Это статичная версия интерфейса на GitHub Pages. Для ответов TITAN.1.R открой приложение на Render после настройки TITAN_API_BASE_URL и TITAN_API_KEY.';
      return;
    }
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: content })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 503 || result.code === 'AI_NOT_CONFIGURED') {
        waiting.querySelector('.message-bubble').textContent = 'PHANTOM запущен, но серверная модель TITAN.1.R ещё не настроена. Добавь TITAN_API_BASE_URL и TITAN_API_KEY в переменные окружения Render. Не вставляй ключ в браузер или GitHub.';
      } else {
        waiting.querySelector('.message-bubble').textContent = result.error || 'Не удалось получить ответ. Попробуй ещё раз позже.';
      }
      return;
    }
    waiting.querySelector('.message-bubble').textContent = result.reply || 'Сервер вернул пустой ответ.';
  } catch {
    waiting.querySelector('.message-bubble').textContent = 'Сервер не найден. Запусти PHANTOM командой npm start или открой опубликованный сайт. Этот интерфейс не подключает ИИ напрямую из браузера.';
  } finally {
    button.disabled = false;
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
}

function newChat() {
  pendingChatTitle = '';
  $('#conversationTitle').textContent = 'Новый чат';
  $('#messages').replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'empty-chat';
  const orb = document.createElement('div'); orb.className = 'mini-orb';
  const title = document.createElement('h3'); title.textContent = 'Начнём разговор?';
  const description = document.createElement('p'); description.className = 'muted'; description.textContent = 'Напиши сообщение ниже — PHANTOM ответит, когда будет подключён ИИ.';
  empty.append(orb, title, description);
  $('#messages').append(empty);
  $('#messageInput').value = '';
  resizeTextarea($('#messageInput'));
  navigate('conversation', { focus: true });
}

function runSearch(query) {
  const normalized = (query || $('#searchInput').value).trim();
  if (!normalized) { $('#searchInput').focus(); showToast('Введи запрос для поиска.'); return; }
  const kindLabel = activeSearchKind === 'repos' ? 'репозитории' : activeSearchKind === 'news' ? 'новости' : 'интернет';
  showToast(`Поиск по категории «${kindLabel}» будет подключён следующим этапом.`);
  const input = $('#searchInput');
  input.value = normalized;
  // Keep the requested query for later real search integration.
  input.dataset.lastQuery = normalized;
}

$('#menuToggle').addEventListener('click', openDrawer);
$('#closeDrawer').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);
$('#quickSettings').addEventListener('click', () => navigate('profile'));
$('#newChatButton').addEventListener('click', newChat);
$('#drawerNewChat').addEventListener('click', newChat);
$$('[data-go]').forEach((button) => button.addEventListener('click', () => {
  const target = button.dataset.go;
  if (target === 'chat' && activeScreen === 'conversation') { navigate('chat'); return; }
  navigate(target);
}));
$$('[data-prompt]').forEach((button) => button.addEventListener('click', () => beginPrompt(button.dataset.prompt)));
$('#chatForm').addEventListener('submit', (event) => { event.preventDefault(); sendMessage($('#messageInput').value); });
$('#messageInput').addEventListener('input', () => resizeTextarea($('#messageInput')));
$('#messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chatForm').requestSubmit(); }
});
$('#searchForm').addEventListener('submit', (event) => { event.preventDefault(); runSearch(); });
$$('[data-query]').forEach((button) => button.addEventListener('click', () => runSearch(button.dataset.query)));
$$('[data-search-kind]').forEach((button) => button.addEventListener('click', () => {
  activeSearchKind = button.dataset.searchKind;
  $$('[data-search-kind]').forEach((item) => item.classList.toggle('active', item === button));
  $('#searchInput').placeholder = activeSearchKind === 'repos' ? 'Найти репозиторий на GitHub…' : activeSearchKind === 'news' ? 'Какие новости тебя интересуют?' : 'Что ты хочешь найти?';
}));
$('#themeSetting').addEventListener('click', () => showToast('Пока доступна только тема PHANTOM: чёрный, графитовый и серебристый.'));
$('#languageSetting').addEventListener('click', () => showToast('Сейчас интерфейс доступен на русском. Другие языки добавим позже.'));
$('#installSetting').addEventListener('click', () => showToast('В Safari нажми «Поделиться» → «На экран Домой». Для установки сайт должен быть опубликован по HTTPS.'));
$('#aboutSetting').addEventListener('click', () => showToast('PHANTOM AI · версия 0.1.0 · мобильный прототип.'));
$('#attachButton').addEventListener('click', () => showToast('Загрузку файлов добавим отдельным этапом.'));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
window.addEventListener('hashchange', () => {
  const target = window.location.hash.slice(1);
  if (['chat', 'search', 'tools', 'profile'].includes(target)) navigate(target, { hash: false });
});

// Register the PWA service worker when served from a secure origin.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {
    // The app remains fully usable if service-worker installation is unavailable.
  }));
}

// Respect a deep link on first load without showing a blank page.
const initialScreen = window.location.hash.slice(1);
if (['search', 'tools', 'profile'].includes(initialScreen)) navigate(initialScreen, { hash: false });
