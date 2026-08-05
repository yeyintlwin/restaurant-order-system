"use strict";

// Every call to core-api, and no DOM. `fetch` is an ARGUMENT rather than a global so
// each branch below is a real test rather than a string match against this file.
//
// It is loaded by the browser as an ES module and by node --test as CommonJS; the
// two-line footer at the bottom is what makes both work without a build step.

// The paths are relative because the proxy puts the API on this same origin. An
// absolute URL here would be a second place that has to agree with nginx.
const ROUTES = Object.freeze({
  me: "/api/admin/auth/me",
  login: "/api/admin/auth/login",
  password: "/api/admin/auth/password",
  logout: "/api/admin/auth/logout",
  logoutAll: "/api/admin/auth/logout-all"
});

function createApi(fetchImpl) {
  // Same-origin, so the __Host- cookie rides along and no CORS mode is involved.
  // Spelling it out rather than relying on the default records that this is a
  // decision: "include" would be the beginning of a cross-origin design.
  const base = { credentials: "same-origin" };

  async function call(path, init = {}) {
    let response;
    try {
      response = await fetchImpl(path, { ...base, ...init });
    } catch {
      // A TypeError from fetch means the request never got an answer -- the proxy is
      // down, or the network is. Never report that as a credential problem.
      return { state: "unreachable" };
    }

    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    return { response, body };
  }

  // ONE place that turns an error body into what the UI shows. The message is the
  // server's, verbatim: 5.8(b) keeps "wrong password" and "unknown email"
  // indistinguishable, and a client that writes its own text is how they drift apart.
  function failure(body) {
    const error = body.error || {};
    return {
      state: "failed",
      code: error.code || "internal_error",
      message: error.message || "Something went wrong.",
      fieldErrors: Array.isArray(error.errors) ? error.errors : []
    };
  }

  function signedIn(me) {
    // 4.2: a 200 that carries mustChangePassword is a different state, not a warning
    // to show on the ordinary one.
    return me.user && me.user.mustChangePassword
      ? { state: "mustChangePassword", me }
      : { state: "signedIn", me };
  }

  return {
    async me() {
      const result = await call(ROUTES.me);
      if (result.state === "unreachable") return result;
      const { response, body } = result;
      if (response.status === 200) return signedIn(body);
      if (response.status === 401) return { state: "signedOut" };
      if (response.status === 403 && body.error && body.error.code === "password_change_required") {
        return { state: "mustChangePassword", me: null };
      }
      return failure(body);
    },

    async login(email, password) {
      const result = await call(ROUTES.login, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      if (result.state === "unreachable") return result;
      const { response, body } = result;
      return response.status === 200 ? signedIn(body) : failure(body);
    },

    async changePassword(currentPassword, newPassword) {
      const result = await call(ROUTES.password, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      if (result.state === "unreachable") return result;
      const { response, body } = result;
      // A success mints a fresh session and kills every other one.
      return response.status === 200 ? { state: "signedIn", me: body } : failure(body);
    },

    async logout(everywhere = false) {
      const result = await call(everywhere ? ROUTES.logoutAll : ROUTES.logout, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      if (result.state === "unreachable") return result;
      const { response, body } = result;
      if (response.status !== 200) return failure(body);
      return { state: "signedOut", revokedSessionCount: body.revokedSessionCount };
    }
  };
}

// Loaded as an ES module in the browser and required by node --test. Two lines
// instead of a bundler.
if (typeof module !== "undefined" && module.exports) module.exports = { createApi, ROUTES };
export { createApi, ROUTES };
