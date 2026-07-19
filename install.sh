#!/data/data/com.termux/files/usr/bin/bash
# install.sh — установка MilaCLI в одну команду (Termux и обычный Linux/macOS/PC).
#
# Что делает:
#   1. Ставит Node.js через pkg (Termux) или проверяет наличие node (ПК).
#   2. Спрашивает, устанавливать ли Agent Mode (реальные клики мышью/
#      клавиатурой + скриншот) — на телефоне это не работает физически,
#      поэтому там вопрос не задаётся, ставится только Code Mode.
#   3. Устанавливает npm-зависимости MilaCLI.
#   4. Регистрирует глобальную команду `mila` (npm link).
#   5. Спрашивает у пользователя уровень effort (low/medium/high)
#      и сразу создаёт готовый профиль в ~/.milacli/config.json —
#      без интерактивного мастера `mila config`.
#
# Запуск (из папки milacli, после распаковки архива):
#   bash install.sh

set -e

echo "== MilaCLI: установка =="

# ---------- Определяем платформу ----------
IS_TERMUX=false
if [ -n "$TERMUX_VERSION" ] || [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=true
fi

if [ "$IS_TERMUX" = true ]; then
  echo "Платформа: Termux (Android)"
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js не найден — устанавливаю через pkg..."
    pkg update -y
    pkg install -y nodejs
  fi
else
  echo "Платформа: $(uname -s) (ПК)"
  if ! command -v node >/dev/null 2>&1; then
    echo "✖ Node.js не найден. Установи Node.js (>=18) вручную и запусти install.sh снова."
    exit 1
  fi
fi

# ---------- Agent Mode: выбор только там, где это физически возможно ----------
INSTALL_AGENT=false

if [ "$IS_TERMUX" = true ]; then
  echo ""
  echo "⚠ Ты на телефоне (Termux/Android). Agent Mode с реальными кликами мышью"
  echo "  и клавиатурой (@nut-tree-fork/nut-js) на Android не работает — это"
  echo "  ограничение платформы, а не баг. Будет установлен только Code Mode"
  echo "  (файлы + терминал). Скриншот/веб-поиск в Agent Mode всё равно доступны,"
  echo "  просто без физических кликов."
  INSTALL_AGENT=false
else
  echo ""
  echo "Установить Agent Mode (mila --agent)?"
  echo "  Это доступ к скриншоту экрана, реальным кликам мышью и вводу с клавиатуры."
  echo "  Требует нативных пакетов под твою ОС — установка займёт чуть дольше."
  read -p "Установить Agent Mode? [y/N]: " agent_choice
  case "$agent_choice" in
    [Yy]*) INSTALL_AGENT=true ;;
    *) INSTALL_AGENT=false ;;
  esac
fi

# ---------- Установка зависимостей ----------
echo ""
echo "Устанавливаю зависимости (npm install)..."
if [ "$INSTALL_AGENT" = true ]; then
  npm install --include=optional
else
  npm install --omit=optional
  echo "Agent Mode пропущен — RPA-пакеты (клики/клавиатура/скриншот) не устанавливались."
  echo "Code Mode (mila, без --agent) работает полностью."
fi

echo ""
echo "Регистрирую глобальную команду 'mila' (npm link)..."
npm link

# ---------- Подписка ----------
# ВАЖНО: install.sh использует общий бесплатный ключ (см. ниже) и всегда
# ставит только базовую подписку MilaCLI. MilaCLI+ — платная, выдаётся
# ТОЛЬКО через официальную покупку и активацию ключом: `mila key`, затем
# `mila key <ключ>` после оплаты. Здесь выбора нет намеренно — иначе
# каждый ставящий через этот скрипт получал бы MilaCLI+ бесплатно.
MODEL="step-3.5-flash-2603"
PLAN="standard"

# ---------- Effort ----------
echo ""
echo "Выбери уровень effort (насколько глубоко модель рассуждает перед ответом):"
echo "  1) low    — быстрее и дешевле, меньше рассуждений"
echo "  2) medium — баланс (рекомендуется)"
echo "  3) high   — медленнее и дороже, глубже рассуждает"
read -p "Введи 1, 2 или 3 [по умолчанию 2]: " effort_choice

case "$effort_choice" in
  1) EFFORT="low" ;;
  3) EFFORT="high" ;;
  *) EFFORT="medium" ;;
esac

CONFIG_DIR="$HOME/.milacli"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# HWID устройства — 12-символьный случайный идентификатор, генерируется
# один раз и сохраняется в device.json. Это информационная метка "с какого
# устройства создан профиль", а НЕ защита сама по себе — единственная
# реальная защита профиля это пароль, который задаётся через `mila config`.
if [ -f "$CONFIG_DIR/device.json" ]; then
  HWID=$(grep -o '"hwid": *"[^"]*"' "$CONFIG_DIR/device.json" | sed 's/.*"\([A-Z0-9]*\)"$/\1/')
fi
if [ -z "$HWID" ]; then
  HWID=$(head -c 32 /dev/urandom | tr -dc 'A-Z0-9' | head -c 12)
  cat > "$CONFIG_DIR/device.json" << DEVEOF
{
  "hwid": "$HWID"
}
DEVEOF
  chmod 600 "$CONFIG_DIR/device.json"
fi

# ВНИМАНИЕ: этот ключ общий для всех, кто ставит Милу через этот скрипт.
# См. предупреждение в README — публичный ключ можно исчерпать/украсть
# кем угодно, кто откроет этот файл.
cat > "$CONFIG_DIR/config.json" << JSONEOF
{
  "currentProfile": "default",
  "profiles": {
    "default": {
      "baseUrl": "https://aihub.071129.xyz/v1",
      "apiKey": "sk-mLfIB1JfxFUmtIxJAH4ywyjE5GMtcE5b2PVOfKS0Ktfm10UO",
      "model": "$MODEL",
      "plan": "$PLAN",
      "effort": "$EFFORT",
      "hwid": "$HWID"
    }
  }
}
JSONEOF

chmod 600 "$CONFIG_DIR/config.json"

echo ""
echo "✔ Готово! Профиль создан: подписка=MilaCLI (стандартная), effort=$EFFORT."
echo "  Пароль на профиль не задан — можешь добавить его позже через 'mila config'."
echo "  Хочешь MilaCLI+ (мощнее, 1\$/мес)? Запусти 'mila key' для покупки."
echo "Запусти:"
echo "  mila            — Code Mode (файлы + терминал)"
if [ "$INSTALL_AGENT" = true ]; then
  echo "  mila --agent    — Agent Mode (+ экран, мышь/клавиатура, веб)"
fi
