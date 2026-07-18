// src/agent-tools.js
// Дополнительные инструменты для режима `mila --agent`: агент "видит" экран
// (скриншот + vision-описание через ту же мультимодальную модель) и умеет
// физически управлять мышью/клавиатурой (реальный RPA через nut-js),
// а также искать в интернете через настоящие HTTP-запросы (не через LLM).
//
// Все инструменты этого файла проходят через ту же двухэтапную систему
// подтверждений (permissions.js), что и файловые/терминальные инструменты
// из tools.js. Клики и ввод текста всегда HIGH-risk — агент физически
// управляет компьютером пользователя, отменить действие после факта нельзя.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { requestPermission, PermissionDeniedError } from './permissions.js';

// screenshot-desktop и @nut-tree-fork/nut-js используют нативные биндинги —
// подключаем их лениво (динамический import), чтобы `mila` (обычный режим
// Claude-Code-стиля без --agent) не падал на машинах, где эти пакеты
// не установлены или не собрались под текущую ОС/архитектуру.
let _screenshot = null;
let _nut = null;

async function loadScreenshot() {
  if (_screenshot) return _screenshot;
  const mod = await import('screenshot-desktop');
  _screenshot = mod.default || mod;
  return _screenshot;
}

async function loadNut() {
  if (_nut) return _nut;
  _nut = await import('@nut-tree-fork/nut-js');
  return _nut;
}

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description:
        'Делает снимок экрана пользователя (всех подключённых мониторов или указанного) и возвращает его модели как изображение для анализа (vision). Используй перед любым кликом, чтобы знать актуальные координаты элементов.',
      parameters: {
        type: 'object',
        properties: {
          screen: { type: 'number', description: 'Индекс монитора (0 — основной), по умолчанию 0' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_screen_size',
      description: 'Возвращает разрешение экрана (ширина/высота в пикселях) — нужно для расчёта координат клика.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse_move',
      description: 'Перемещает курсор мыши в указанные экранные координаты (без клика).',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mouse_click',
      description: 'Кликает мышью по указанным экранным координатам. Реально управляет курсором пользователя.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'По умолчанию left' },
          double: { type: 'boolean', description: 'Двойной клик, по умолчанию false' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'keyboard_type',
      description: 'Печатает указанный текст так, будто его набрали на физической клавиатуре, в то поле, которое сейчас в фокусе.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'keyboard_press',
      description:
        'Нажимает комбинацию клавиш (например Enter, Escape, Ctrl+C, Ctrl+A). Клавиши перечисляются массивом, зажимаются вместе и отпускаются в обратном порядке.',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Например ["control","c"] или ["enter"]',
          },
        },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Ищет в интернете через поисковую систему (реальный HTTP-запрос) и возвращает список результатов с заголовком, ссылкой и коротким сниппетом.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'number', description: 'По умолчанию 5, максимум 10' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Загружает содержимое веб-страницы по точному URL и возвращает очищенный текст (без HTML-тегов).',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  },
];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Экран ----------

async function toolTakeScreenshot({ screen = 0 }, risk, autoYes) {
  const allowed = await requestPermission({
    toolName: 'take_screenshot',
    action: 'Сделать снимок экрана',
    risk,
    details: {},
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  try {
    const screenshot = await loadScreenshot();
    const tmpPath = path.join(os.tmpdir(), `mila-screenshot-${Date.now()}.jpg`);
    await screenshot({ filename: tmpPath, screen, format: 'jpg' });
    const buffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    return {
      success: true,
      note: 'Скриншот снят и передан модели как изображение (image_url, base64).',
      image_base64: buffer.toString('base64'),
      mime_type: 'image/jpeg',
    };
  } catch (err) {
    return {
      error:
        `Не удалось сделать скриншот: ${err.message}. ` +
        'Возможно нужны системные права (macOS: Screen Recording в Приватности; Linux: X11/scrot/wayland-плагин).',
    };
  }
}

async function toolGetScreenSize() {
  try {
    const { screen } = await loadNut();
    const size = await screen.width().then(async (width) => ({ width, height: await screen.height() }));
    return { width: size.width, height: size.height };
  } catch (err) {
    return { error: `Не удалось получить размер экрана: ${err.message}` };
  }
}

// ---------- Мышь и клавиатура (RPA) ----------

async function toolMouseMove({ x, y }, risk, autoYes) {
  if (x === undefined || y === undefined) return { error: 'Параметры "x" и "y" обязательны.' };
  const allowed = await requestPermission({
    toolName: 'mouse_move',
    action: `Переместить курсор в (${x}, ${y})`,
    risk,
    details: {},
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  try {
    const { mouse, Point } = await loadNut();
    await mouse.setPosition(new Point(x, y));
    return { success: true, x, y };
  } catch (err) {
    return { error: `Не удалось переместить курсор: ${err.message}` };
  }
}

async function toolMouseClick({ x, y, button = 'left', double = false }, risk, autoYes) {
  if (x === undefined || y === undefined) return { error: 'Параметры "x" и "y" обязательны.' };
  const allowed = await requestPermission({
    toolName: 'mouse_click',
    action: chalk.red(`${double ? 'Двойной клик' : 'Клик'} (${button}) в точке (${x}, ${y}) — физическое управление мышью`),
    risk,
    details: {},
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  try {
    const { mouse, Point, Button } = await loadNut();
    const btn = button === 'right' ? Button.RIGHT : button === 'middle' ? Button.MIDDLE : Button.LEFT;
    await mouse.setPosition(new Point(x, y));
    if (double) {
      await mouse.doubleClick(btn);
    } else {
      await mouse.click(btn);
    }
    return { success: true, x, y, button, double };
  } catch (err) {
    return { error: `Не удалось выполнить клик: ${err.message}` };
  }
}

async function toolKeyboardType({ text }, risk, autoYes) {
  if (text === undefined) return { error: 'Параметр "text" обязателен.' };
  const allowed = await requestPermission({
    toolName: 'keyboard_type',
    action: chalk.red(`Ввести текст с клавиатуры: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`),
    risk,
    details: {},
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  try {
    const { keyboard } = await loadNut();
    await keyboard.type(text);
    return { success: true, length: text.length };
  } catch (err) {
    return { error: `Не удалось напечатать текст: ${err.message}` };
  }
}

async function toolKeyboardPress({ keys }, risk, autoYes) {
  if (!Array.isArray(keys) || keys.length === 0) return { error: 'Параметр "keys" должен быть непустым массивом.' };
  const allowed = await requestPermission({
    toolName: 'keyboard_press',
    action: chalk.red(`Нажать комбинацию клавиш: ${keys.join(' + ')}`),
    risk,
    details: {},
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  try {
    const { keyboard, Key } = await loadNut();
    const mapped = keys.map((k) => {
      const upper = k.toUpperCase();
      return Key[upper] ?? Key[k[0].toUpperCase() + k.slice(1).toLowerCase()];
    });
    if (mapped.some((k) => k === undefined)) {
      return { error: `Неизвестная клавиша в комбинации: ${keys.join(', ')}` };
    }
    await keyboard.pressKey(...mapped);
    await keyboard.releaseKey(...mapped);
    return { success: true, keys };
  } catch (err) {
    return { error: `Не удалось нажать комбинацию клавиш: ${err.message}` };
  }
}

// ---------- Веб ----------

async function toolWebSearch({ query, max_results = 5 }, risk, autoYes) {
  if (!query) return { error: 'Параметр "query" обязателен.' };
  const allowed = await requestPermission({
    toolName: 'web_search',
    action: `Поиск в интернете: "${query}"`,
    risk,
    details: {},
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  const limit = Math.min(Math.max(1, max_results), 10);

  try {
    // DuckDuckGo HTML-версия не требует API-ключа — используется как
    // дефолтный бесключевой поисковик. При наличии своего ключа/провайдера
    // (Bing, SerpAPI, Google CSE) — замени этот блок на соответствующий запрос.
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MilaAgent/1.0)' },
    });
    if (!res.ok) return { error: `Поисковый запрос завершился с кодом ${res.status}` };
    const html = await res.text();

    const results = [];
    const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links = [...html.matchAll(linkRegex)];
    const snippets = [...html.matchAll(snippetRegex)];

    for (let i = 0; i < Math.min(links.length, limit); i++) {
      results.push({
        title: stripHtml(links[i][2]),
        url: links[i][1],
        snippet: snippets[i] ? stripHtml(snippets[i][1]) : '',
      });
    }
    return { query, results };
  } catch (err) {
    return { error: `Ошибка веб-поиска: ${err.message}` };
  }
}

async function toolWebFetch({ url }, risk, autoYes) {
  if (!url) return { error: 'Параметр "url" обязателен.' };
  const allowed = await requestPermission({
    toolName: 'web_fetch',
    action: `Загрузить страницу: ${url}`,
    risk,
    details: {},
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MilaAgent/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return { error: `Запрос завершился с кодом ${res.status}` };
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();
    const text = contentType.includes('html') ? stripHtml(raw) : raw;
    const MAX = 15000;
    return {
      url,
      content: text.length > MAX ? text.slice(0, MAX) + `\n...[обрезано, всего ${text.length} симв.]` : text,
    };
  } catch (err) {
    return { error: `Не удалось загрузить страницу: ${err.message}` };
  }
}

// ---------- Риски и роутинг ----------

export function riskForAgentTool(toolName) {
  const map = {
    take_screenshot: 'low',
    get_screen_size: 'low',
    mouse_move: 'medium',
    mouse_click: 'high',
    keyboard_type: 'high',
    keyboard_press: 'high',
    web_search: 'low',
    web_fetch: 'medium',
  };
  return map[toolName] || 'high';
}

export async function executeAgentTool(name, argsRaw, { autoYes = false } = {}) {
  let args;
  try {
    args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : argsRaw || {};
  } catch (e) {
    return { error: `Некорректные аргументы JSON для инструмента "${name}": ${e.message}` };
  }

  const risk = riskForAgentTool(name);
  try {
    switch (name) {
      case 'take_screenshot':
        return await toolTakeScreenshot(args, risk, autoYes);
      case 'get_screen_size':
        return await toolGetScreenSize(args, risk, autoYes);
      case 'mouse_move':
        return await toolMouseMove(args, risk, autoYes);
      case 'mouse_click':
        return await toolMouseClick(args, risk, autoYes);
      case 'keyboard_type':
        return await toolKeyboardType(args, risk, autoYes);
      case 'keyboard_press':
        return await toolKeyboardPress(args, risk, autoYes);
      case 'web_search':
        return await toolWebSearch(args, risk, autoYes);
      case 'web_fetch':
        return await toolWebFetch(args, risk, autoYes);
      default:
        return { error: `Неизвестный инструмент agent-режима: ${name}` };
    }
  } catch (err) {
    if (err instanceof PermissionDeniedError) throw err;
    return { error: `Непредвиденная ошибка выполнения инструмента "${name}": ${err.message}` };
  }
}
