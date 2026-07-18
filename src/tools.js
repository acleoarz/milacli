// src/tools.js
// Описание инструментов (в формате function-calling для OpenAI-совместимых
// API) и их реальное исполнение: чтение/запись/редактирование/удаление
// файлов, выполнение команд в терминале и поиск по коду.
// Каждый инструмент перед выполнением проходит через permissions.js.

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { diffLines } from 'diff';
import { glob } from 'glob';
import chalk from 'chalk';
import { requestPermission, riskForTool, PermissionDeniedError } from './permissions.js';

const execAsync = promisify(exec);

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Читает содержимое текстового файла по указанному пути относительно рабочей директории.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Путь к файлу' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Возвращает список файлов и папок в указанной директории.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Путь к директории (по умолчанию текущая)' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Создаёт новый файл или полностью перезаписывает существующий указанным содержимым.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Заменяет точный текстовый фрагмент old_text на new_text внутри существующего файла (частичное редактирование).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Безвозвратно удаляет файл или директорию.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Выполняет shell-команду в терминале пользователя (bash на macOS/Linux, PowerShell на Windows) и возвращает stdout/stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Рабочая директория для команды' },
          timeout: { type: 'number', description: 'Таймаут в миллисекундах (по умолчанию 60000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Ищет строку или regex-паттерн по файлам проекта (аналог grep).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Директория поиска (по умолчанию текущая)' },
          mask: { type: 'string', description: 'glob-маска файлов, например **/*.js' },
        },
        required: ['pattern'],
      },
    },
  },
];

function truncate(s = '', max = 5000) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '\n...[вывод обрезан]' : s;
}

function formatDiff(oldStr, newStr) {
  const parts = diffLines(oldStr, newStr);
  return parts
    .map((part) => {
      const color = part.added ? chalk.green : part.removed ? chalk.red : chalk.gray;
      const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
      const lines = part.value.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.map((l) => color(prefix + l)).join('\n');
    })
    .join('\n');
}

async function toolReadFile({ path: p }, risk, autoYes) {
  if (!p) return { error: 'Параметр "path" обязателен.' };
  const allowed = await requestPermission({ toolName: 'read_file', action: 'Прочитать содержимое файла', risk, details: { path: p }, autoYes });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };
  const full = path.resolve(process.cwd(), p);
  if (!fs.existsSync(full)) return { error: `Файл не найден: ${p}` };
  if (fs.statSync(full).isDirectory()) return { error: `"${p}" является директорией, используйте list_dir.` };
  const content = fs.readFileSync(full, 'utf-8');
  const MAX = 20000;
  return {
    path: p,
    content: content.length > MAX ? content.slice(0, MAX) + `\n...[обрезано, всего ${content.length} симв.]` : content,
  };
}

async function toolListDir({ path: p = '.' }, risk, autoYes) {
  const allowed = await requestPermission({ toolName: 'list_dir', action: 'Просмотреть содержимое директории', risk, details: { path: p }, autoYes });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };
  const full = path.resolve(process.cwd(), p);
  if (!fs.existsSync(full)) return { error: `Директория не найдена: ${p}` };
  const entries = fs.readdirSync(full, { withFileTypes: true });
  return { path: p, entries: entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)) };
}

async function toolWriteFile({ path: p, content }, risk, autoYes) {
  if (!p || content === undefined) return { error: 'Параметры "path" и "content" обязательны.' };
  const full = path.resolve(process.cwd(), p);
  const exists = fs.existsSync(full);
  const preview = exists
    ? formatDiff(fs.readFileSync(full, 'utf-8'), content)
    : chalk.green(`[новый файл, ${content.split('\n').length} строк]`);

  const allowed = await requestPermission({
    toolName: 'write_file',
    action: exists ? 'Перезаписать существующий файл' : 'Создать новый файл',
    risk,
    details: { path: p, preview },
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return { success: true, path: p, bytesWritten: Buffer.byteLength(content) };
}

async function toolEditFile({ path: p, old_text, new_text }, risk, autoYes) {
  if (!p || old_text === undefined || new_text === undefined) {
    return { error: 'Параметры "path", "old_text", "new_text" обязательны.' };
  }
  const full = path.resolve(process.cwd(), p);
  if (!fs.existsSync(full)) return { error: `Файл не найден: ${p}` };

  const original = fs.readFileSync(full, 'utf-8');
  if (!original.includes(old_text)) {
    return { error: `Фрагмент "old_text" не найден в файле ${p}. Убедитесь в точном совпадении текста (включая отступы и переносы строк).` };
  }
  const updated = original.replace(old_text, new_text);
  const preview = formatDiff(original, updated);

  const allowed = await requestPermission({ toolName: 'edit_file', action: 'Изменить фрагмент файла', risk, details: { path: p, preview }, autoYes });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  fs.writeFileSync(full, updated, 'utf-8');
  return { success: true, path: p };
}

async function toolDeleteFile({ path: p }, risk, autoYes) {
  if (!p) return { error: 'Параметр "path" обязателен.' };
  const full = path.resolve(process.cwd(), p);
  if (!fs.existsSync(full)) return { error: `Путь не найден: ${p}` };

  const allowed = await requestPermission({
    toolName: 'delete_file',
    action: chalk.red('БЕЗВОЗВРАТНО удалить файл/папку'),
    risk,
    details: { path: p },
    autoYes,
  });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  fs.rmSync(full, { recursive: true, force: true });
  return { success: true, path: p };
}

async function toolRunCommand({ command, cwd, timeout = 60000 }, risk, autoYes) {
  if (!command) return { error: 'Параметр "command" обязателен.' };
  const allowed = await requestPermission({ toolName: 'run_command', action: 'Выполнить команду в терминале', risk, details: { command, path: cwd }, autoYes });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd ? path.resolve(process.cwd(), cwd) : process.cwd(),
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
    });
    return { success: true, stdout: truncate(stdout), stderr: truncate(stderr) };
  } catch (err) {
    // Auto-Heal: ошибка команды не роняет процесс, а возвращается модели как результат,
    // чтобы она могла проанализировать вывод и исправить команду сама.
    return {
      error: `Команда завершилась с ошибкой (код ${err.code ?? '?'}): ${err.message}`,
      stdout: truncate(err.stdout),
      stderr: truncate(err.stderr),
    };
  }
}

async function toolSearchCode({ pattern, path: dir = '.', mask = '**/*' }, risk, autoYes) {
  if (!pattern) return { error: 'Параметр "pattern" обязателен.' };
  const allowed = await requestPermission({ toolName: 'search_code', action: 'Поиск по файлам проекта', risk, details: { path: dir }, autoYes });
  if (!allowed) return { error: 'Действие отклонено пользователем.' };

  const files = await glob(mask, {
    cwd: path.resolve(process.cwd(), dir),
    nodir: true,
    ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
  });

  let regex;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    regex = null;
  }

  const results = [];
  for (const f of files.slice(0, 500)) {
    const full = path.resolve(process.cwd(), dir, f);
    let content;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    content.split('\n').forEach((line, idx) => {
      const match = regex ? regex.test(line) : line.includes(pattern);
      if (match) results.push(`${f}:${idx + 1}: ${line.trim().slice(0, 200)}`);
    });
    if (results.length > 200) break;
  }
  return { matches: results.slice(0, 200), total: results.length };
}

/**
 * Единая точка исполнения любого инструмента по имени.
 * Возвращает объект-результат (никогда не бросает "грязные" исключения наружу,
 * кроме явного прерывания пользователем — PermissionDeniedError) — это основа
 * для механизма Auto-Heal в agent.js: модель видит { error: "..." } и способна
 * самостоятельно скорректировать следующий шаг.
 */
export async function executeTool(name, argsRaw, { autoYes = false } = {}) {
  let args;
  try {
    args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : argsRaw || {};
  } catch (e) {
    return { error: `Некорректные аргументы JSON для инструмента "${name}": ${e.message}` };
  }

  const risk = riskForTool(name);
  try {
    switch (name) {
      case 'read_file':
        return await toolReadFile(args, risk, autoYes);
      case 'list_dir':
        return await toolListDir(args, risk, autoYes);
      case 'write_file':
        return await toolWriteFile(args, risk, autoYes);
      case 'edit_file':
        return await toolEditFile(args, risk, autoYes);
      case 'delete_file':
        return await toolDeleteFile(args, risk, autoYes);
      case 'run_command':
        return await toolRunCommand(args, risk, autoYes);
      case 'search_code':
        return await toolSearchCode(args, risk, autoYes);
      default:
        return { error: `Неизвестный инструмент: ${name}` };
    }
  } catch (err) {
    if (err instanceof PermissionDeniedError) throw err;
    return { error: `Непредвиденная ошибка выполнения инструмента "${name}": ${err.message}` };
  }
}
