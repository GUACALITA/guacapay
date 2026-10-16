// Fills the email templates. Values are escaped for HTML only in the HTML version.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(here, 'templates');
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const cache = new Map();

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function load(file) {
  if (!cache.has(file)) {
    cache.set(file, readFileSync(join(TEMPLATES_DIR, file), 'utf8'));
  }
  return cache.get(file);
}

function fill(source, values, encode) {
  return source.replace(PLACEHOLDER, (_, key) => {
    if (!(key in values)) {
      // A missing value is a bug in the caller, so fail loudly rather than send "{{code}}" to someone.
      throw new Error(`email template placeholder "${key}" has no value`);
    }
    return encode(values[key]);
  });
}

// Returns { text, html } for one email type, e.g. renderEmail('login-code', { code: '123456' }).
export function renderEmail(name, values) {
  return {
    text: fill(load(`${name}.txt`), values, (value) => String(value)),
    html: fill(load(`${name}.html`), values, escapeHtml),
  };
}
