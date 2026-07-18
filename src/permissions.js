// src/permissions.js
// Модуль безопасности: перед КАЖДЫМ системным действием агент обязан
// запросить подтверждение пользователя. Реализует двухэтапную защиту:
//   1) классификация риска действия (low / medium / high),
//   2) интерактивный запрос с вариантами: один раз / в этой сессии /
//      всегда (сохраняется на диск) / отклонить / прервать всё.
// Дополнительно контролирует "песочницу" — предупреждает, если путь
// выходит за пределы текущей рабочей директории.

import inquirer from 'inquirer';
import chalk from 'chalk';
import path from 'node:path';
import { loadPermissions, savePermissions } from './config.js';

export const RISK = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };

const RISK_LABELS = {
  low: chalk.green('НИЗКИЙ'),
  medium: chalk.yellow('СРЕДНИЙ'),
  high: chalk.red.bold('ВЫСОКИЙ'),
};

// Разрешения, выданные только на текущую сессию процесса (в память, не на диск).
const sessionAllow = new Set();

export class PermissionDeniedError extends Error {
  constructor(msg = 'Операция прервана пользователем.') {
    super(msg);
    this.name = 'PermissionDeniedError';
  }
}

function isOutsideCwd(targetPath) {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, targetPath);
  const rel = path.relative(cwd, resolved);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

export function riskForTool(toolName) {
  const map = {
    // Базовые инструменты (файлы/терминал)
    read_file: RISK.LOW,
    list_dir: RISK.LOW,
    search_code: RISK.LOW,
    write_file: RISK.MEDIUM,
    edit_file: RISK.MEDIUM,
    delete_file: RISK.HIGH,
    run_command: RISK.HIGH,
    // Инструменты agent-режима (экран/веб/RPA) — см. agent-tools.js
    take_screenshot: RISK.LOW,
    get_screen_size: RISK.LOW,
    mouse_move: RISK.MEDIUM,
    mouse_click: RISK.HIGH,
    keyboard_type: RISK.HIGH,
    keyboard_press: RISK.HIGH,
    web_search: RISK.LOW,
    web_fetch: RISK.MEDIUM,
  };
  return map[toolName] || RISK.MEDIUM;
}

/**
 * Запрашивает подтверждение действия у пользователя.
 * @param {object} opts
 * @param {string} opts.toolName - имя инструмента (ключ для persist-правил)
 * @param {string} opts.action - человекочитаемое описание действия
 * @param {'low'|'medium'|'high'} opts.risk
 * @param {{path?:string, command?:string, preview?:string}} opts.details
 * @param {boolean} opts.autoYes - режим `--yes` (не подтверждает high-risk!)
 */
export async function requestPermission({ toolName, action, risk = RISK.MEDIUM, details = {}, autoYes = false }) {
  const persisted = loadPermissions();
  const key = toolName;

  // --yes допускает автоматическое подтверждение только для low/medium риска.
  if (autoYes && risk !== RISK.HIGH) return true;
  if (persisted.always?.[key]) return true;
  if (sessionAllow.has(key)) return true;

  console.log('\n' + chalk.bgBlack.white.bold(' ЗАПРОС ПОДТВЕРЖДЕНИЯ ДЕЙСТВИЯ '));
  console.log(chalk.bold('Инструмент:    ') + chalk.cyan(toolName));
  console.log(chalk.bold('Действие:      ') + action);
  console.log(chalk.bold('Уровень риска: ') + (RISK_LABELS[risk] || risk));

  if (details.path) {
    const outside = isOutsideCwd(details.path);
    console.log(chalk.bold('Путь:          ') + details.path + (outside ? chalk.red('  [ВНЕ РАБОЧЕЙ ДИРЕКТОРИИ!]') : ''));
    if (outside) {
      console.log(chalk.red('⚠ Внимание: агент пытается выйти за пределы текущей рабочей папки (sandbox). Будьте внимательны.'));
    }
  }
  if (details.command) {
    console.log(chalk.bold('Команда:       ') + chalk.magenta(details.command));
  }
  if (details.preview) {
    console.log(chalk.gray('──── Предпросмотр изменений ────'));
    console.log(details.preview);
    console.log(chalk.gray('─────────────────────────────────'));
  }

  const { choice } = await inquirer.prompt([
    {
      type: 'list',
      name: 'choice',
      message: 'Разрешить это действие?',
      choices: [
        { name: 'Да, разрешить один раз', value: 'once' },
        { name: 'Да, и не спрашивать больше в этой сессии', value: 'session' },
        { name: 'Да, разрешать всегда (сохранить в настройках)', value: 'always' },
        { name: 'Нет, отклонить это действие', value: 'deny' },
        { name: 'Прервать всю операцию агента', value: 'abort' },
      ],
      default: 'once',
    },
  ]);

  if (choice === 'session') sessionAllow.add(key);
  if (choice === 'always') {
    persisted.always = persisted.always || {};
    persisted.always[key] = true;
    savePermissions(persisted);
  }
  if (choice === 'abort') throw new PermissionDeniedError();

  return choice !== 'deny';
}

export function clearSessionPermissions() {
  sessionAllow.clear();
}
