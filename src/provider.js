// src/provider.js
// Клиент для работы с OpenAI-совместимыми API: обычные и потоковые (SSE)
// запросы chat/completions, а также быстрый пинг-тест соединения,
// используемый командой `mila config`.

export class ProviderError extends Error {
  constructor(message, { status, data, network, timeout } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.data = data;
    this.network = !!network;
    this.timeout = !!timeout;
  }
}

export class Provider {
  constructor({ baseUrl, apiKey, model, effort } = {}) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.effort = effort || 'medium';
  }

  get endpoint() {
    return `${this.baseUrl}/chat/completions`;
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Микро-запрос "Привет" с таймаутом 10с — используется для диагностики
   * подключения в мастере `mila config`.
   */
  async ping(timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'Привет' }],
          max_tokens: 15,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        return { ok: false, status: res.status, data };
      }
      const text = data?.choices?.[0]?.message?.content ?? '(пустой ответ)';
      return { ok: true, status: res.status, data, text };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err.name === 'AbortError';
      return { ok: false, network: true, timeout: isAbort, error: err };
    }
  }

  /**
   * Обычный (не потоковый) запрос. Используется как fallback и в местах,
   * где стриминг не нужен. Делает до `retries` повторов при сетевых сбоях.
   */
  async complete({ messages, tools, retries = 2 }) {
    let attempt = 0;
    let lastErr;
    while (attempt <= retries) {
      try {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify({
            model: this.model,
            messages,
            tools: tools?.length ? tools : undefined,
            tool_choice: tools?.length ? 'auto' : undefined,
            reasoning_effort: this.effort,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new ProviderError(data?.error?.message || `HTTP ${res.status}`, { status: res.status, data });
        }
        return data;
      } catch (err) {
        lastErr = err;
        attempt++;
        if (attempt > retries) break;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    throw lastErr;
  }

  /**
   * Потоковая генерация (SSE). Инкрементально собирает как текстовый
   * контент, так и tool_calls (они приходят частями по индексу).
   */
  async stream({ messages, tools, onContent, onToolCallDelta }) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        model: this.model,
        messages,
        tools: tools?.length ? tools : undefined,
        tool_choice: tools?.length ? 'auto' : undefined,
        reasoning_effort: this.effort,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    if (!res.ok || !res.body) {
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* тело могло быть пустым */
      }
      throw new ProviderError(data?.error?.message || `HTTP ${res.status}`, { status: res.status, data });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCalls = [];
    let usage = null;
    let finishReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue; // неполный/битый чанк — пропускаем
        }

        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || {};
        if (delta.content) {
          content += delta.content;
          onContent?.(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
          onToolCallDelta?.(delta.tool_calls);
        }
      }
    }

    return { content, toolCalls: toolCalls.filter(Boolean), usage, finishReason };
  }
}

export default Provider;
