// The one place the browser talks to the backend.
// The session token lives in sessionStorage only: it clears when the tab closes and is never written to localStorage.

const TOKEN_KEY = 'guacapay.session';
const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

// Every failed call becomes an ApiError with the same shape.
export class ApiError extends Error {
  constructor({ code, message, status, requestId }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export function createApi({ baseUrl = '', fetchImpl = (...args) => globalThis.fetch(...args), storage = globalThis.sessionStorage } = {}) {
  // Storage can be blocked (private mode, disabled site data). Then the user simply stays signed out.
  function getToken() {
    try {
      return storage?.getItem(TOKEN_KEY) ?? null;
    } catch {
      return null;
    }
  }

  function setToken(token) {
    try {
      if (token) {
        storage?.setItem(TOKEN_KEY, token);
      } else {
        storage?.removeItem(TOKEN_KEY);
      }
    } catch {
      // Ignored: see getToken.
    }
  }

  async function request(method, path, { body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const token = auth ? getToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError({
        code: 'network_error',
        message: 'Could not reach the server. Check your connection and try again.',
        status: 0,
        requestId: null,
      });
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      // A rejected token means the session is over.
      if (response.status === 401 && token) setToken(null);

      const error = data?.error;
      throw new ApiError({
        code: error?.code ?? 'http_error',
        message: error?.message ?? FALLBACK_MESSAGE,
        status: response.status,
        requestId: error?.requestId ?? null,
      });
    }

    return data;
  }

  return {
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    getToken,
    setToken,
    isSignedIn: () => getToken() !== null,
  };
}

// Shared instance for the pages.
export const api = createApi();
