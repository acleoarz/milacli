// src/agent.js
// Основной "мозг" MilaCLI: Reasoning Loop (модель рассуждает и планирует)
// + Tool-Calling Loop (модель вызывает инструменты, получает результат,
// продолжает рассуждать) + Auto-Heal (ошибки инструментов и сети не роняют
// процесс, а превращаются в контекст для самокоррекции модели).
//
// Два режима:
//   - обычный (mila): только файлы/терминал — как Claude Code / Codex CLI.
//   - agent-режим (mila --agent): плюс "видит" экран (скриншот -> vision),
//     реально управляет мышью/клавиатурой (RPA) и ищет в интернете
//     настоящими HTTP-запросами. См. agent-tools.js.

import chalk from 'chalk';
import ora from 'ora';
import { Provider, ProviderError } from './provider.js';
import { TOOLS, executeTool } from './tools.js';
import { AGENT_TOOLS, executeAgentTool } from './agent-tools.js';
import { TokenCounter } from './tokens.js';
import { PermissionDeniedError } from './permissions.js';

const MAX_ITERATIONS = 20;
const MAX_NETWORK_RETRIES = 2;

const BASE_TOOL_NAMES = new Set(['read_file', 'list_dir', 'write_file', 'edit_file', 'delete_file', 'run_command', 'search_code']);

function buildSystemPrompt(agentMode) {
  const base = `Тебя зовут Мила. Ты автономный профессиональный AI-агент для разработки программного обеспечения,
работающий локально в терминале пользователя с полным доступом к файловой системе и shell.

Правила работы:
1. Действуй итеративно: изучи контекст (list_dir, read_file, search_code) перед внесением изменений.
2. Любое изменение файлов или выполнение команд проходит подтверждение пользователя — это нормально, не пытайся его обойти.
3. Для точечных правок используй edit_file (old_text -> new_text), для создания новых файлов или полной перезаписи — write_file.
4. Если инструмент вернул { error: ... } — это не крах, а часть работы: проанализируй причину и попробуй скорректированный подход (Auto-Heal).
5. Для проверки своей работы используй run_command (тесты, линтеры, сборка).
6. Отвечай кратко и по делу, на языке пользователя (по умолчанию — русский).
7. Не выдумывай содержимое файлов — используй read_file, чтобы убедиться в реальном состоянии проекта.

Рабочая директория: ${process.cwd()}
Операционная система: ${process.platform}`;

  if (!agentMode) return base;

  return (
    base +
    `

РЕЖИМ АГЕНТА (--agent) включён. Дополнительно у тебя есть:
8. take_screenshot — сделать снимок экрана, чтобы увидеть текущее состояние монитора пользователя.
   Всегда снимай скриншот перед кликом, если не уверена в актуальных координатах элементов.
9. get_screen_size — размер экрана в пикселях, чтобы рассчитывать координаты.
10. mouse_move / mouse_click — реально двигают и кликают физическим курсором пользователя.
11. keyboard_type / keyboard_press — реально печатают текст и нажимают клавиши на клавиатуре пользователя.
    Эти четыре действия необратимы и происходят на живом компьютере человека — используй их точно и осторожно,
    объясняй перед серией кликов, что собираешься сделать.
12. web_search / web_fetch — настоящий поиск в интернете и загрузка страниц (не выдумывай факты, когда можешь проверить).

Перед любой последовательностью кликов сначала сделай take_screenshot и опиши, что видишь и что собираешься нажать.`
  );
}

export class Agent {
  constructor(profile, { autoYes = false, agentMode = false } = {}) {
    this.profile = profile;
    this.provider = new Provider(profile);
    this.tokens = new TokenCounter();
    this.autoYes = autoYes;
    this.agentMode = agentMode;
    this.tools = agentMode ? [...TOOLS, ...AGENT_TOOLS] : TOOLS;
    this.history = [{ role: 'system', content: buildSystemPrompt(agentMode) }];
  }

  resetContext() {
    this.history = [this.history[0]];
  }

  /** Основной публичный метод: отправить сообщение пользователя и дождаться финального ответа. */
  async chat(userInput) {
    this.history.push({ role: 'user', content: userInput });
    let iterations = 0;
    let finalText = '';

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const spinner = ora({ text: chalk.gray('Мила думает...'), color: 'yellow' }).start();
      let result;
      try {
        result = await this._streamWithHealing(spinner);
      } catch (err) {
        spinner.stop();
        if (err instanceof PermissionDeniedError) {
          console.log(chalk.red('\n✖ Операция прервана пользователем.'));
          return finalText;
        }
        this._printProviderError(err);
        return finalText;
      }
      spinner.stop();

      const { content, toolCalls, usage } = result;
      if (usage) this.tokens.add(usage);
      else this.tokens.addEstimated(JSON.stringify(this.history.slice(-4)), content || '');

      if (content) finalText += content;

      const assistantMsg = { role: 'assistant', content: content || '' };
      if (toolCalls?.length) assistantMsg.tool_calls = toolCalls;
      this.history.push(assistantMsg);

      if (!toolCalls || toolCalls.length === 0) break; // модель закончила без вызова инструментов

      // ---- Tool-Calling Loop ----
      for (const call of toolCalls) {
        const toolName = call.function?.name || '(unknown)';
        console.log('\n' + chalk.blue('🔧 Вызов инструмента: ') + chalk.bold(toolName));

        let toolResult;
        try {
          toolResult = BASE_TOOL_NAMES.has(toolName)
            ? await executeTool(toolName, call.function?.arguments || '{}', { autoYes: this.autoYes })
            : await executeAgentTool(toolName, call.function?.arguments || '{}', { autoYes: this.autoYes });
        } catch (err) {
          if (err instanceof PermissionDeniedError) throw err;
          toolResult = { error: `Непредвиденная ошибка инструмента: ${err.message}` };
        }

        if (toolResult?.error) console.log(chalk.red(`  ↳ Ошибка: ${toolResult.error}`));
        else console.log(chalk.green('  ↳ Успешно выполнено.'));

        const toolCallId = call.id || `call_${Math.random().toString(36).slice(2)}`;

        // take_screenshot возвращает картинку — часть провайдеров ожидает
        // изображение не внутри tool-result JSON, а отдельным сообщением
        // с image_url, чтобы модель реально его "увидела" (vision).
        if (toolName === 'take_screenshot' && toolResult?.image_base64) {
          this.history.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify({ success: true, note: 'Скриншот приложен следующим сообщением.' }),
          });
          this.history.push({
            role: 'user',
            content: [
              { type: 'text', text: 'Вот текущий скриншот экрана:' },
              { type: 'image_url', image_url: { url: `data:${toolResult.mime_type};base64,${toolResult.image_base64}` } },
            ],
          });
        } else {
          this.history.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(toolResult ?? {}),
          });
        }
      }
      // Возвращаемся в начало цикла — модель анализирует результаты (Reasoning Loop).
    }

    if (iterations >= MAX_ITERATIONS) {
      console.log(chalk.yellow('\n⚠ Достигнут лимит итераций агента (защита от зацикливания). Уточните задачу или продолжите диалог.'));
    }
    return finalText;
  }

  /** Обёртка над Provider.stream с ретраями при сетевых сбоях (Auto-Heal соединения). */
  async _streamWithHealing(spinner) {
    let attempt = 0;
    let firstChunk = true;

    while (true) {
      try {
        const res = await this.provider.stream({
          messages: this.history,
          tools: this.tools,
          onContent: (chunk) => {
            if (firstChunk) {
              spinner.stop();
              process.stdout.write(chalk.cyanBright('\n🥬 Мила: '));
              firstChunk = false;
            }
            process.stdout.write(chunk);
          },
        });
        if (!firstChunk) process.stdout.write('\n');
        return res;
      } catch (err) {
        attempt++;
        const isClientError = err instanceof ProviderError && err.status && err.status < 500 && err.status !== 429;
        if (isClientError || attempt > MAX_NETWORK_RETRIES) throw err;
        spinner.text = chalk.gray(`Сбой соединения, повторная попытка ${attempt}/${MAX_NETWORK_RETRIES}...`);
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
  }

  _printProviderError(err) {
    if (err instanceof ProviderError) {
      console.log(chalk.red(`\n✖ Ошибка API (${err.status ?? '?'}): ${err.message}`));
    } else {
      console.log(chalk.red(`\n✖ Критическая ошибка: ${err.message}`));
    }
  }
}

export default Agent;
