#!/usr/bin/env node
// src/index.js
// Точка входа CLI: обработка команд (config, profiles, use, run) и
// интерактивный REPL-режим по умолчанию. Визуальное оформление через
// chalk/ora/boxen.
//
// Флаг --agent включает расширенный режим: агент "видит" экран (скриншот),
// реально управляет мышью/клавиатурой (RPA) и ищет в интернете настоящими
// HTTP-запросами — см. agent-tools.js. Без флага — обычный режим
// Claude-Code/Codex-CLI-стиля: только файлы текущего проекта и терминал.

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import boxen from 'boxen';
import {
  getCurrentProfile,
  saveProfile,
  setCurrentProfile,
  listProfiles,
  configExists,
} from './config.js';
import { Provider } from './provider.js';
import { Agent } from './agent.js';

const program = new Command();
program
  .name('mila')
  .description('MilaCLI — локальный AI-агент «Мила» для разработки в терминале')
  .version('1.0.0')
  .option('--agent', 'Включить режим агента: видит экран, управляет мышью/клавиатурой, ищет в интернете');

/** Очищает терминал так, чтобы MilaCLI выглядела отдельным "окном" поверх обычной консоли. */
function clearTerminal() {
  // ANSI: очистить экран + перевести курсор в (0,0). Работает в bash/zsh/PowerShell/cmd (Node ≥ 12).
  process.stdout.write('\x1Bc');
}

function banner(agentMode) {
  console.log(
    chalk.magentaBright(
      [
        '  888b     d888 d8b 888          ',
        '  8888b   d8888 Y8P 888          ',
        '  88888b.d88888     888          ',
        '  888Y88888P888 888 888  8888b.  ',
        '  888 Y888P 888 888 888     "88b ',
        '  888  Y8P  888 888 888 .d888888 ',
        '  888   "   888 888 888 888  888 ',
        '  888       888 888 888 "Y888888 ',
      ].join('\n'),
    ),
  );
  const modeLabel = agentMode
    ? chalk.bgMagenta.black.bold(' AGENT MODE ') + chalk.gray(' — экран · мышь/клавиатура · веб')
    : chalk.bgCyan.black.bold(' CODE MODE ') + chalk.gray(' — файлы · терминал (как Claude Code)');
  console.log(
    boxen(chalk.gray('Мила · локальный AI-агент для разработки · v1.0.0') + '\n' + modeLabel, {
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      margin: { top: 0, bottom: 1, left: 0, right: 0 },
      borderColor: agentMode ? 'magenta' : 'cyan',
      borderStyle: 'round',
    }),
  );
}

/** Интеллектуальная диагностика пинг-теста согласно ТЗ. */
async function runPingDiagnostics(profileAnswers) {
  const spinner = ora('Проверка соединения с API...').start();
  const provider = new Provider(profileAnswers);
  const result = await provider.ping(10000);
  spinner.stop();

  if (result.ok) {
    console.log(
      boxen(
        chalk.green.bold('[ OK ] Соединение успешно установлено! Модель готова к работе.') +
          `\n\n${chalk.gray('Ответ модели:')} ${chalk.white(result.text)}`,
        { padding: 1, borderColor: 'green', borderStyle: 'round' },
      ),
    );
    return true;
  }

  if (result.network) {
    console.log(
      boxen(
        chalk.red.bold('⚠ Сетевая ошибка.') +
          '\n' +
          (result.timeout ? 'Превышен таймаут ожидания (10 секунд).' : 'Сервер недоступен.') +
          '\nПроверьте ваш интернет, работу VPN или доступность прокси.',
        { padding: 1, borderColor: 'red', borderStyle: 'round' },
      ),
    );
    return false;
  }

  switch (result.status) {
    case 401:
      console.log(
        boxen(
          chalk.red.bold('⚠ Ошибка авторизации.') + '\nВаш API-ключ недействителен. Проверьте пробелы и правильность копирования.',
          { padding: 1, borderColor: 'red', borderStyle: 'round' },
        ),
      );
      break;
    case 404:
      console.log(
        boxen(
          chalk.red.bold('⚠ Ошибка 404. Не найдена модель или конечная точка.') +
            `\nУбедитесь, что провайдер поддерживает модель '${profileAnswers.model}' и вы верно ввели Base URL.`,
          { padding: 1, borderColor: 'red', borderStyle: 'round' },
        ),
      );
      break;
    case 429:
      console.log(
        boxen(
          chalk.red.bold('⚠ Ошибка лимитов.') + '\nНа вашем балансе закончились средства или превышена частота запросов.',
          { padding: 1, borderColor: 'red', borderStyle: 'round' },
        ),
      );
      break;
    default:
      console.log(
        boxen(
          chalk.red.bold(`⚠ Неожиданная ошибка сервера (код ${result.status ?? '?'}).`) +
            `\n\n${chalk.gray(JSON.stringify(result.data, null, 2))}`,
          { padding: 1, borderColor: 'red', borderStyle: 'round' },
        ),
      );
  }
  return false;
}

program
  .command('config')
  .description('Интерактивная настройка профиля подключения к API')
  .action(async () => {
    clearTerminal();
    banner(false);
    const existing = listProfiles();
    const answers = await inquirer.prompt([
      { type: 'input', name: 'name', message: 'Имя профиля:', default: existing.current || 'default' },
      { type: 'input', name: 'baseUrl', message: 'Base URL (OpenAI-совместимый API):', default: 'https://aihub.071129.xyz/v1' },
      { type: 'password', name: 'apiKey', message: 'API-ключ:', mask: '*' },
      { type: 'input', name: 'model', message: 'Имя модели:', default: 'step-3.5-flash-2603' },
      { type: 'list', name: 'effort', message: 'Уровень эффорта рассуждений:', choices: ['low', 'medium', 'high'], default: 'medium' },
    ]);

    const ok = await runPingDiagnostics(answers);

    let save = ok;
    if (!ok) {
      const { forceSave } = await inquirer.prompt([
        { type: 'confirm', name: 'forceSave', message: 'Всё равно сохранить эту конфигурацию?', default: false },
      ]);
      save = forceSave;
    }

    if (save) {
      const { name, ...profile } = answers;
      saveProfile(name, profile);
      console.log(chalk.green(`\n✔ Профиль "${name}" сохранён в ~/.milacli/config.json`));
    } else {
      console.log(chalk.yellow('\nКонфигурация не сохранена.'));
    }
  });

program
  .command('profiles')
  .description('Список сохранённых профилей')
  .action(() => {
    const { current, profiles } = listProfiles();
    const names = Object.keys(profiles);
    if (!names.length) {
      console.log(chalk.yellow('Профили не найдены. Выполните `mila config`.'));
      return;
    }
    names.forEach((n) => {
      const marker = n === current ? chalk.green('● ') : '  ';
      console.log(`${marker}${n} ${chalk.gray(`(${profiles[n].model})`)}`);
    });
  });

program
  .command('use <name>')
  .description('Переключить активный профиль')
  .action((name) => {
    try {
      setCurrentProfile(name);
      console.log(chalk.green(`✔ Активный профиль: ${name}`));
    } catch (e) {
      console.log(chalk.red(e.message));
    }
  });

program
  .command('run <prompt...>')
  .option('-y, --yes', 'Автоматически подтверждать действия низкого/среднего риска (НЕ действует на high-risk: удаление, команды, клики, ввод текста)')
  .description('Выполнить агента с промптом в одноразовом режиме')
  .action(async (promptParts, opts) => {
    const profile = getCurrentProfile();
    if (!profile) {
      console.log(chalk.red('Нет активного профиля. Выполните `mila config`.'));
      return;
    }
    const agentMode = !!program.opts().agent;
    const agent = new Agent(profile, { autoYes: !!opts.yes, agentMode });
    await agent.chat(promptParts.join(' '));
    console.log('\n' + agent.tokens.summary());
  });

// Интерактивный REPL-режим по умолчанию (без подкоманд).
program.action(async () => {
  const agentMode = !!program.opts().agent;

  clearTerminal();
  banner(agentMode);

  if (!configExists()) {
    console.log(
      boxen(
        chalk.yellow.bold('Профиль ещё не настроен.') +
          '\n\nЗапусти ' + chalk.cyan('mila config') + ' — Base URL и модель уже подставлены\n' +
          '(' + chalk.gray('https://aihub.071129.xyz/v1, step-3.5-flash-2603') + '), нужно ввести только свой API-ключ.',
        { padding: 1, borderColor: 'yellow', borderStyle: 'round' },
      ),
    );
    return;
  }

  const profile = getCurrentProfile();
  console.log(chalk.gray(`Профиль: ${profile.name} · Модель: ${profile.model} · Эффорт: ${profile.effort}`));
  if (agentMode) {
    console.log(
      chalk.yellow(
        '⚠ Agent-режим: Мила может физически двигать мышь, кликать, печатать и снимать скриншоты твоего экрана.\n' +
          '  Каждое такое действие всё равно требует твоего подтверждения (см. систему прав).',
      ),
    );
  }
  console.log(chalk.gray('Команды: /exit — выход, /tokens — статистика, /clear — очистить контекст\n'));

  const agent = new Agent(profile, { autoYes: false, agentMode });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { input } = await inquirer.prompt([{ type: 'input', name: 'input', message: chalk.bold('Вы:') }]);
    const trimmed = (input || '').trim();
    if (!trimmed) continue;
    if (trimmed === '/exit') break;
    if (trimmed === '/tokens') {
      console.log(agent.tokens.summary());
      continue;
    }
    if (trimmed === '/clear') {
      agent.resetContext();
      console.log(chalk.gray('Контекст очищен.'));
      continue;
    }
    await agent.chat(trimmed);
    console.log(chalk.gray(agent.tokens.statusLine()));
  }
  console.log(chalk.gray('До встречи!'));
});

process.on('uncaughtException', (err) => {
  console.log(chalk.red(`\n✖ Непредвиденная ошибка: ${err.message}`));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.log(chalk.red(`\n✖ Необработанная ошибка промиса: ${err?.message || err}`));
});

program.parseAsync(process.argv);
