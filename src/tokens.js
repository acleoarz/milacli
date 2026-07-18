// src/tokens.js
// Счётчик токенов в реальном времени: сколько отправлено (input),
// получено (output) и суммарно за сессию/запрос.

import chalk from 'chalk';

export class TokenCounter {
  constructor() {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.requests = 0;
  }

  /** Добавить точные данные usage, пришедшие от API (prompt/completion tokens). */
  add(usage = {}) {
    const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
    this.inputTokens += inTok;
    this.outputTokens += outTok;
    this.requests += 1;
    return { inTok, outTok };
  }

  get total() {
    return this.inputTokens + this.outputTokens;
  }

  /** Грубая эвристическая оценка токенов (~4 символа на токен), если API не вернул usage. */
  estimate(text = '') {
    return Math.max(1, Math.ceil(String(text).length / 4));
  }

  addEstimated(inputText, outputText) {
    const inTok = this.estimate(inputText);
    const outTok = this.estimate(outputText);
    this.inputTokens += inTok;
    this.outputTokens += outTok;
    this.requests += 1;
    return { inTok, outTok, estimated: true };
  }

  /** Компактная строка статуса для вывода после каждого ответа. */
  statusLine() {
    return chalk.gray(`↑${this.inputTokens} ↓${this.outputTokens} Σ${this.total} токенов · ${this.requests} запр.`);
  }

  /** Подробная сводка по завершении сессии/команды run. */
  summary() {
    return [
      chalk.bold('Статистика использования токенов:'),
      `  Входные (промпт):  ${chalk.cyan(this.inputTokens)}`,
      `  Выходные (ответ):  ${chalk.green(this.outputTokens)}`,
      `  Всего:             ${chalk.yellow(this.total)}`,
      `  Запросов к API:    ${this.requests}`,
    ].join('\n');
  }
}

export default TokenCounter;
