// Wiring for wallet-setup.html: fills in the official links from config/setup.json. The page has no form fields.
const $ = (id) => document.getElementById(id);

// Only https links are used; anything else is left out rather than trusted.
function safeHttpsUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function loadSetupConfig() {
  const response = await fetch('config/setup.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('setup config unavailable');
  return response.json();
}

async function start() {
  try {
    const config = await loadSetupConfig();

    const signUp = safeHttpsUrl(config.walletSignUpUrl);
    if (signUp) {
      $('signup-link').href = signUp;
      $('signup-link').hidden = false;
    } else {
      $('signup-unavailable').hidden = false;
    }

    const keyDocs = safeHttpsUrl(config.keyDocumentationUrl);
    if (keyDocs) {
      $('key-docs-link').href = keyDocs;
      $('key-docs-link').hidden = false;
    }
  } catch {
    $('signup-unavailable').hidden = false;
  }
}

start();
