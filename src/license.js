// src/license.js
// Ручная выдача лицензий MilaCLI+ без сервера и без API YooMoney.
//
// Схема (асимметричная подпись Ed25519 — секрет ты никогда не публикуешь):
//   1. Пользователь запускает `mila key` — получает RequestCode
//      (детерминированно выведен из HWID устройства). Он публичный,
//      им можно свободно делиться — сам по себе он ничего не даёт.
//   2. Присылает тебе RequestCode + подтверждение оплаты.
//   3. Ты (у тебя есть приватный ключ MILA_LICENSE_PRIVATE_KEY, хранится
//      только у тебя, никогда не в репозитории) генерируешь ключ активации
//      командой `mila issue-key <RequestCode>`.
//   4. Пользователь вводит ключ через `mila key <ключ>`. MilaCLI проверяет
//      подпись ПУБЛИЧНЫМ ключом (он зашит в код — это не секрет, публичным
//      ключом можно только ПРОВЕРИТЬ подпись, а не создать новую). Если
//      подпись верна для именно этого RequestCode — активируется MilaCLI+.
//
// Ключ работает только для того устройства/RequestCode, для которого был
// подписан — скопировать чужой ключ на другой HWID не получится, подпись
// не совпадёт (RequestCode другой).

import crypto from 'node:crypto';
import { getDeviceHwid } from './config.js';

const REQUEST_CODE_LENGTH = 10;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов (0/O, 1/I/L)

// Публичный ключ Ed25519 — НЕ секрет, им можно только проверять подписи,
// не создавать новые. Безопасно хранить прямо в открытом репозитории.
const LICENSE_PUBLIC_KEY_DER_BASE64 =
  'MCowBQYDK2VwAyEAt4epBjHRSqJpLjiL3pAojp9OiRNJMaA7SmkJiE4gFU8=';

function getPublicKeyObject() {
  return crypto.createPublicKey({
    key: Buffer.from(LICENSE_PUBLIC_KEY_DER_BASE64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

function getPrivateKeyObject(privateKeyBase64) {
  return crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * RequestCode детерминированно зависит от HWID устройства. Один и тот же
 * HWID всегда даёт один и тот же RequestCode — переустановка MilaCLI на
 * том же устройстве не требует повторной оплаты, ключ вводится тот же.
 */
export function getRequestCode() {
  const hwid = getDeviceHwid();
  const digest = crypto.createHash('sha256').update(`milacli-request:${hwid}`).digest();
  let code = '';
  for (let i = 0; i < REQUEST_CODE_LENGTH; i++) {
    code += CODE_CHARS[digest[i] % CODE_CHARS.length];
  }
  return code.match(/.{1,5}/g).join('-'); // формат XXXXX-XXXXX для читаемости
}

/**
 * Только ты вызываешь это — требует приватный ключ (переменная окружения
 * MILA_LICENSE_PRIVATE_KEY, base64 DER PKCS8). Возвращает ключ активации
 * для конкретного RequestCode пользователя.
 */
export function issueLicenseKey(requestCode, privateKeyBase64) {
  if (!privateKeyBase64) {
    throw new Error('MILA_LICENSE_PRIVATE_KEY не задан в окружении — ключ выдать нельзя.');
  }
  const normalized = requestCode.trim().toUpperCase();
  const privateKey = getPrivateKeyObject(privateKeyBase64);
  const signature = crypto.sign(null, Buffer.from(normalized), privateKey).toString('base64url');
  return `${normalized}#${signature}`;
}

/**
 * Проверка ключа активации на стороне ЛЮБОГО пользователя — не требует
 * приватного ключа, только встроенный публичный. Сверяет, что подпись
 * действительно сделана держателем приватного ключа (тобой) и что она
 * относится именно к RequestCode этого устройства.
 */
export function verifyLicenseKey(key) {
  if (!key || !key.includes('#')) return { valid: false, reason: 'Некорректный формат ключа.' };

  const trimmed = key.trim();
  const [requestCodeRaw, signatureB64] = trimmed.split('#');
  const requestCodeInKey = (requestCodeRaw || '').toUpperCase();
  const myRequestCode = getRequestCode();

  if (requestCodeInKey !== myRequestCode) {
    return { valid: false, reason: 'Этот ключ выдан для другого устройства (RequestCode не совпадает).' };
  }
  if (!signatureB64) return { valid: false, reason: 'Некорректный формат ключа.' };

  try {
    const publicKey = getPublicKeyObject();
    const isValid = crypto.verify(null, Buffer.from(requestCodeInKey), publicKey, Buffer.from(signatureB64, 'base64url'));
    return { valid: isValid, reason: isValid ? null : 'Подпись недействительна.' };
  } catch (err) {
    return { valid: false, reason: `Ошибка проверки подписи: ${err.message}` };
  }
}
