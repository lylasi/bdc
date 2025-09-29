// Local-only global settings & secrets (never synced)
// Keys
const SETTINGS_KEY = 'pen_global_settings';
const SECRETS_KEY = 'pen_global_secrets';

const defaults = {
  ai: { apiUrl: '', models: {} }, // request endpoint & per-feature model override
  tts: { baseUrl: '' },
  updatedAt: null
};

export function loadGlobalSettings() {
  try { const raw = localStorage.getItem(SETTINGS_KEY); if (!raw) return { ...defaults };
    const s = JSON.parse(raw);
    return { ...defaults, ...s, ai: { ...defaults.ai, ...(s.ai||{}) }, tts: { ...defaults.tts, ...(s.tts||{}) } };
  } catch(_) { return { ...defaults }; }
}

export function saveGlobalSettings(partial) {
  const cur = loadGlobalSettings();
  const next = {
    ...cur,
    ...partial,
    ai: { ...cur.ai, ...(partial?.ai || {}) },
    tts: { ...cur.tts, ...(partial?.tts || {}) },
    updatedAt: new Date().toISOString()
  };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); return next; } catch(_) { return cur; }
}

export function loadGlobalSecrets() {
  try { const raw = localStorage.getItem(SECRETS_KEY); return raw ? JSON.parse(raw) : {}; } catch(_) { return {}; }
}

export function saveGlobalSecrets(partial) {
  const cur = loadGlobalSecrets();
  const next = { ...cur, ...(partial || {}), updatedAt: new Date().toISOString() };
  try { localStorage.setItem(SECRETS_KEY, JSON.stringify(next)); return next; } catch(_) { return cur; }
}
