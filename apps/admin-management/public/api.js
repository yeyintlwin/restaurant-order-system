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
  logoutAll: "/api/admin/auth/logout-all",
  scope: "/api/admin/scope",
  companies: "/api/platform/companies",
  platformAdmins: "/api/platform/admins",
  shops: "/api/admin/shops",
  users: "/api/admin/users"
});

// Query strings are built here rather than by each caller, so a parameter the API
// does not accept cannot be sent by accident and an absent one is never "null".
function withQuery(path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query === "" ? path : `${path}?${query}`;
}

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
    },

    // ---- the console -----------------------------------------------------
    //
    // Every resource call funnels through `resource` below, so there is ONE place
    // that decides what a non-2xx means. The alternative -- a status check per
    // method -- is twenty places for the 401 handling to drift apart, and the one
    // that drifts is the one nobody tests.

    ...(() => {
      async function resource(path, init) {
        const result = await call(path, init);
        if (result.state === "unreachable") return result;
        const { response, body } = result;
        // A session that died under the user is not a failure of the thing they
        // clicked. The console re-checks and shows the sign-in screen, which is
        // the only honest answer.
        if (response.status === 401) return { state: "signedOut" };
        if (response.status >= 200 && response.status < 300) return { state: "ok", data: body };
        return failure(body);
      }

      const json = (method, body) => ({
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      return {
        // A platform admin selects the company they are acting inside. null clears
        // it, and the API insists the key is PRESENT either way -- {} and
        // {"companyId": null} are two different requests.
        selectScope: (companyId) => resource(ROUTES.scope, json("POST", { companyId })),

        listCompanies: (params) => resource(withQuery(ROUTES.companies, params)),
        getCompany: (id) => resource(`${ROUTES.companies}/${id}`),
        createCompany: (input) => resource(ROUTES.companies, json("POST", input)),
        updateCompany: (id, changes) => resource(`${ROUTES.companies}/${id}`, json("PATCH", changes)),

        listPlatformAdmins: (params) => resource(withQuery(ROUTES.platformAdmins, params)),
        createPlatformAdmin: (input) => resource(ROUTES.platformAdmins, json("POST", input)),
        updatePlatformAdmin: (id, changes) =>
          resource(`${ROUTES.platformAdmins}/${id}`, json("PATCH", changes)),
        resetPlatformAdminPassword: (id) =>
          resource(`${ROUTES.platformAdmins}/${id}/password-reset`, json("POST", {})),

        listShops: (params) => resource(withQuery(ROUTES.shops, params)),
        getShop: (id) => resource(`${ROUTES.shops}/${id}`),
        createShop: (input) => resource(ROUTES.shops, json("POST", input)),
        updateShop: (id, changes) => resource(`${ROUTES.shops}/${id}`, json("PATCH", changes)),
        // PUT, not PATCH: the manager slot is REPLACED, and the body always says
        // which of the three states the shop is being left in.
        setShopManager: (id, input) => resource(`${ROUTES.shops}/${id}/manager`, json("PUT", input)),
        updateShopDayToDay: (id, changes) =>
          resource(`${ROUTES.shops}/${id}/day-to-day`, json("PATCH", changes)),

        listUsers: (params) => resource(withQuery(ROUTES.users, params)),
        getUser: (id) => resource(`${ROUTES.users}/${id}`),
        createUser: (input) => resource(ROUTES.users, json("POST", input)),
        updateUser: (id, changes) => resource(`${ROUTES.users}/${id}`, json("PATCH", changes)),
        resetUserPassword: (id) => resource(`${ROUTES.users}/${id}/password-reset`, json("POST", {}))
      };
    })()
  };
}

// Loaded as an ES module in the browser and required by node --test. Two lines
// instead of a bundler.
if (typeof module !== "undefined" && module.exports) module.exports = { createApi, ROUTES };
export { createApi, ROUTES };
