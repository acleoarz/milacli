// src/plans.js
// Тарифы MilaCLI. Пользователь при `mila config` выбирает не техническое
// название модели, а простой тариф — реальная модель провайдера подставляется
// автоматически и не показывается в интерфейсе как "имя модели".

export const PLANS = {
  standard: {
    id: 'standard',
    label: 'MilaCLI',
    description: 'Стандартная подписка — быстрые ответы для повседневных задач',
    model: 'step-3.5-flash-2603',
  },
  plus: {
    id: 'plus',
    label: 'MilaCLI+',
    description: 'Расширенная подписка — более мощная модель для сложных задач',
    model: 'Qwen3.5-397B-A17B',
  },
};

export function getPlanChoices() {
  return Object.values(PLANS).map((p) => ({
    name: `${p.label} — ${p.description}`,
    value: p.id,
  }));
}

export function getPlanById(id) {
  return PLANS[id] || PLANS.standard;
}

/** По имени модели в уже сохранённом профиле определяет, к какому тарифу она относится (для отображения в /profiles и статусной строке). */
export function getPlanByModel(model) {
  const found = Object.values(PLANS).find((p) => p.model === model);
  return found || null;
}
