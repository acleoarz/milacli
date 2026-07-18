// src/config.js
// Управление локальной конфигурацией MilaCLI: профили подключения к API
// и постоянные разрешения (permissions), хранящиеся в домашней директории
// пользователя: ~/.milacli/config.json и ~/.milacli/permissions.json

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR = path.join(os.homedir(), '.milacli');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const PERMISSIONS_PATH = path.join(CONFIG_DIR, 'permissions.json');

const DEFAULT_CONFIG = { currentProfile: null, profiles: {} };
const DEFAULT_PERMISSIONS = { always: {}, deniedPaths: [] };

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return deepClone(fallback);
    const raw = fs.readFileSync(filePath, 'utf-8');
    return { ...deepClone(fallback), ...JSON.parse(raw) };
  } catch {
    // Битый/повреждённый файл конфигурации — не роняем процесс,
    // просто откатываемся к значениям по умолчанию.
    return deepClone(fallback);
  }
}

function writeJsonSafe(filePath, data) {
  ensureDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function loadConfig() {
  return readJsonSafe(CONFIG_PATH, DEFAULT_CONFIG);
}

export function saveConfig(cfg) {
  writeJsonSafe(CONFIG_PATH, cfg);
}

export function saveProfile(name, profile) {
  const cfg = loadConfig();
  cfg.profiles[name] = profile;
  if (!cfg.currentProfile) cfg.currentProfile = name;
  saveConfig(cfg);
  return cfg;
}

export function getCurrentProfile() {
  const cfg = loadConfig();
  if (!cfg.currentProfile || !cfg.profiles[cfg.currentProfile]) return null;
  return { name: cfg.currentProfile, ...cfg.profiles[cfg.currentProfile] };
}

export function setCurrentProfile(name) {
  const cfg = loadConfig();
  if (!cfg.profiles[name]) {
    throw new Error(`Профиль "${name}" не найден. Доступные профили: ${Object.keys(cfg.profiles).join(', ') || '(нет)'}`);
  }
  cfg.currentProfile = name;
  saveConfig(cfg);
}

export function removeProfile(name) {
  const cfg = loadConfig();
  delete cfg.profiles[name];
  if (cfg.currentProfile === name) {
    cfg.currentProfile = Object.keys(cfg.profiles)[0] || null;
  }
  saveConfig(cfg);
}

export function listProfiles() {
  const cfg = loadConfig();
  return { current: cfg.currentProfile, profiles: cfg.profiles };
}

export function configExists() {
  const cfg = loadConfig();
  return !!(cfg.currentProfile && cfg.profiles[cfg.currentProfile]);
}

export function loadPermissions() {
  return readJsonSafe(PERMISSIONS_PATH, DEFAULT_PERMISSIONS);
}

export function savePermissions(perm) {
  writeJsonSafe(PERMISSIONS_PATH, perm);
}

export function resetPermissions() {
  savePermissions(deepClone(DEFAULT_PERMISSIONS));
}
