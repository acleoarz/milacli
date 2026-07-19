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
  hashPassword,
  verifyPassword,
  needsPasswordCheck,
  getDeviceHwid,
} from './config.js';
import { getPlanChoices, getPlanById, getPlanByModel } from './plans.js';
import { getRequestCode, issueLicenseKey, verifyLicenseKey } from './license.js';
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
      { type: 'list', name: 'plan', message: 'Подписка:', choices: getPlanChoices(), default: 'standard' },
      { type: 'list', name: 'effort', message: 'Уровень эффорта рассуждений:', choices: ['low', 'medium', 'high'], default: 'medium' },
      { type: 'confirm', name: 'setPassword', message: 'Установить пароль на этот профиль?', default: false },
    ]);

    let passwordHash = null;
    if (answers.setPassword) {
      const { password, confirmPassword } = await inquirer.prompt([
        { type: 'password', name: 'password', message: 'Придумай пароль:', mask: '*' },
        { type: 'password', name: 'confirmPassword', message: 'Повтори пароль:', mask: '*' },
      ]);
      if (!password || password !== confirmPassword) {
        console.log(chalk.red('Пароли не совпадают или пусты — профиль будет сохранён без пароля.'));
      } else {
        passwordHash = hashPassword(password);
      }
    }

    const plan = getPlanById(answers.plan);
    const pingPayload = { baseUrl: answers.baseUrl, apiKey: answers.apiKey, model: plan.model, effort: answers.effort };
    const ok = await runPingDiagnostics(pingPayload);

    let save = ok;
    if (!ok) {
      const { forceSave } = await inquirer.prompt([
        { type: 'confirm', name: 'forceSave', message: 'Всё равно сохранить эту конфигурацию?', default: false },
      ]);
      save = forceSave;
    }

    if (save) {
      const profile = {
        baseUrl: answers.baseUrl,
        apiKey: answers.apiKey,
        model: plan.model,
        plan: plan.id,
        effort: answers.effort,
        hwid: getDeviceHwid(),
      };
      if (passwordHash) profile.passwordHash = passwordHash;
      saveProfile(answers.name, profile);
      console.log(chalk.green(`\n✔ Профиль "${answers.name}" (${plan.label}) сохранён в ~/.milacli/config.json`));
      if (passwordHash) console.log(chalk.gray('  Профиль защищён паролем — на другом устройстве при входе он будет запрошен.'));
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
      const plan = getPlanByModel(profiles[n].model);
      const lock = profiles[n].passwordHash ? chalk.yellow(' 🔒') : '';
      console.log(`${marker}${n} ${chalk.gray(`(${plan ? plan.label : profiles[n].model})`)}${lock}`);
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

/**
 * Если профиль защищён паролем и создан на другом устройстве (HWID не
 * совпадает с текущим) — просит ввести пароль перед тем, как отдать
 * профиль в работу. Возвращает true, если можно продолжать.
 */
async function unlockProfile(profile) {
  if (!needsPasswordCheck(profile)) return true;

  console.log(
    boxen(
      chalk.yellow.bold('🔒 Профиль защищён паролем.') +
        '\nЭтот профиль был создан на другом устройстве — введи пароль, чтобы продолжить.',
      { padding: 1, borderColor: 'yellow', borderStyle: 'round' },
    ),
  );

  for (let attempt = 0; attempt < 3; attempt++) {
    const { password } = await inquirer.prompt([{ type: 'password', name: 'password', message: 'Пароль:', mask: '*' }]);
    if (verifyPassword(password, profile.passwordHash)) return true;
    console.log(chalk.red(`✖ Неверный пароль (попытка ${attempt + 1}/3).`));
  }
  console.log(chalk.red('Доступ отклонён.'));
  return false;
}

program
  .command('key [activationKey]')
  .description('Без аргумента — показать свой код запроса для покупки MilaCLI+. С ключом — активировать подписку.')
  .action(async (activationKey) => {
    if (!activationKey) {
      const code = getRequestCode();
      console.log(
        boxen(
          chalk.bold('Твой код для покупки MilaCLI+:') +
            `\n\n${chalk.cyanBright.bold(code)}\n\n` +
            chalk.white('1. Оплати 1$/мес: ') + chalk.underline('https://yoomoney.ru/to/4100119523655218/100') + '\n' +
            chalk.white('2. Пришли этот код и подтверждение оплаты в Telegram: ') + chalk.cyanBright.bold('@AnonymNakaz') + '\n' +
            chalk.white('3. В ответ придёт ключ активации — активируй его командой:') + '\n' +
            '   ' + chalk.cyan(`mila key ${code}#<ключ>`),
          { padding: 1, borderColor: 'cyan', borderStyle: 'round' },
        ),
      );
      return;
    }

    const { valid, reason } = verifyLicenseKey(activationKey);
    if (!valid) {
      console.log(chalk.red(`✖ Ключ не принят: ${reason}`));
      return;
    }

    const profile = getCurrentProfile();
    if (!profile) {
      console.log(chalk.red('Нет активного профиля. Сначала выполни `mila config`.'));
      return;
    }

    const cfg = listProfiles();
    const plusPlan = getPlanById('plus');
    const updated = { ...cfg.profiles[profile.name], model: plusPlan.model, plan: plusPlan.id, licenseKey: activationKey.trim() };
    saveProfile(profile.name, updated);
    console.log(chalk.green(`✔ MilaCLI+ активирована для профиля "${profile.name}"!`));
  });

program
  .command('issue-key <requestCode>')
  .description('[Только для владельца] Выдать ключ активации MilaCLI+ по коду запроса пользователя.')
  .action((requestCode) => {
    const privateKey = process.env.MILA_LICENSE_PRIVATE_KEY;
    if (!privateKey) {
      console.log(chalk.red('✖ Переменная окружения MILA_LICENSE_PRIVATE_KEY не задана — выдавать ключи может только владелец.'));
      return;
    }
    try {
      const key = issueLicenseKey(requestCode, privateKey);
      console.log(boxen(chalk.green.bold('Ключ активации:') + `\n\n${chalk.cyanBright(key)}`, { padding: 1, borderColor: 'green', borderStyle: 'round' }));
      console.log(chalk.gray('Отправь этот ключ покупателю целиком — он вводит его через `mila key <ключ>`.'));
    } catch (err) {
      console.log(chalk.red(`✖ ${err.message}`));
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
    if (!(await unlockProfile(profile))) return;
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
          '\n\nЗапусти ' + chalk.cyan('mila config') + ' — Base URL уже подставлен\n' +
          '(' + chalk.gray('https://aihub.071129.xyz/v1') + '), останется ввести API-ключ и выбрать подписку.',
        { padding: 1, borderColor: 'yellow', borderStyle: 'round' },
      ),
    );
    return;
  }

  const profile = getCurrentProfile();
  if (!(await unlockProfile(profile))) return;

  const plan = getPlanByModel(profile.model);
  console.log(chalk.gray(`Профиль: ${profile.name} · Подписка: ${plan ? plan.label : profile.model} · Эффорт: ${profile.effort}`));
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
