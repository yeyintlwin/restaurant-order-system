// The console: everything that exists once we know who is signed in.
//
// It owns the DOM and holds no fetch. Every request goes through the api object it is
// handed, which is the file with the tests; every decision that is not a DOM
// operation lives in shape.js, which is the other file with the tests. What is left
// here is wiring, and wiring is what a browser is for.
//
// The markup is the mockup's, unchanged apart from the transforms recorded at the top
// of index.html's build. Where a comment here says "the design says", the argument for
// it is in docs/superpowers/specs/2026-08-06-admin-console-roles-design.md.

import {
  personaOf,
  roleLabel,
  resolveScreen,
  slugify,
  slugProblem,
  describeFailure,
  initials,
  managerState
} from "/shape.js";

const $ = (id) => document.getElementById(id);
const all = (selector, root = document) => [...root.querySelectorAll(selector)];

// ---------------------------------------------------------------------------
// The two lists the console has to translate
// ---------------------------------------------------------------------------

// The API stores language as a code, because that is what a machine needs; a person
// picks from names. One table, so the two can never be entered separately and drift.
const LANGUAGES = [
  ["en", "English"],
  ["my", "မြန်မာ — Burmese"],
  ["th", "ไทย — Thai"],
  ["zh", "中文 — Chinese"],
  ["ja", "日本語 — Japanese"]
];

// Same shape, same reason. The stored value is the ISO code alone.
const CURRENCIES = [
  ["MMK", "MMK — Kyat"],
  ["THB", "THB — Baht"],
  ["CNY", "CNY — Yuan"],
  ["JPY", "JPY — Yen"],
  ["USD", "USD — Dollar"]
];

const TIME_ZONES = ["Asia/Yangon", "Asia/Bangkok", "Asia/Shanghai", "Asia/Tokyo"];

const labelFor = (table, code) => {
  const found = table.find((entry) => entry[0] === code);
  // An unrecognised code is shown as itself rather than hidden. A shop set to a
  // language this list has not heard of still has to be readable.
  return found ? found[1] : code || "";
};

function fillSelect(select, entries, { placeholder = null } = {}) {
  select.textContent = "";
  if (placeholder !== null) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = placeholder;
    select.append(blank);
  }
  for (const [value, text] of entries) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
}

// ---------------------------------------------------------------------------
// mountConsole
// ---------------------------------------------------------------------------

export function mountConsole({ api, me, onSignedOut }) {
  const state = {
    me,
    persona: personaOf(me),
    screen: "dashboard",
    companies: [],
    shops: [],
    users: [],
    // The shop a manager holding more than one is currently looking at (§3.0.1).
    // Every screen below the rail is about ONE shop, and this is what says which.
    activeShopId: null,
    // Set while a platform admin is borrowing a company's scope for one operation,
    // so a failure can put it back rather than stranding them inside a tenant.
    borrowing: false
  };

  // -------------------------------------------------------------------------
  // Talking to the server
  // -------------------------------------------------------------------------

  // ONE place that reacts to a dead session. A 401 arriving under a click is not a
  // failure of the thing that was clicked, and every screen would otherwise have to
  // remember to say so.
  async function send(run) {
    const result = await run();
    if (result && result.state === "signedOut") {
      onSignedOut();
      return null;
    }
    return result;
  }

  // A platform admin reaches into a company for exactly one write and comes back.
  // The finally is the whole point: a throw halfway through must not leave them
  // scoped into somebody else's company with a platform owner's menu.
  async function insideCompany(companyId, run) {
    const entered = await send(() => api.selectScope(companyId));
    if (entered === null) return null;
    if (entered.state !== "ok") return entered;
    state.borrowing = true;
    try {
      return await run();
    } finally {
      state.borrowing = false;
      await api.selectScope(null);
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  const rail = $("rail");
  const scrim = $("scrim");
  const menu = $("menu");
  const main = document.querySelector(".main");

  // The exact complement of the drawer's own media query. `(min-width:901px)` would
  // leave fractional widths such as 900.5 matching neither, and the drawer would
  // never be told to close on the way up.
  const wide = matchMedia("not all and (max-width:900px)");

  function drawer(open) {
    if (wide.matches) open = false;
    rail.classList.toggle("open", open);
    scrim.hidden = !open;
    document.body.classList.toggle("locked", open);
    menu.setAttribute("aria-expanded", String(open));
    // Everything behind the scrim is dimmed, so it has to be unreachable by Tab too.
    main.inert = open;
    const into = open ? all("[data-go]", rail).find((a) => a.offsetParent) : menu;
    if (into) into.focus();
  }

  menu.addEventListener("click", () => drawer(!rail.classList.contains("open")));
  scrim.addEventListener("click", () => drawer(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && rail.classList.contains("open")) drawer(false);
  });
  wide.addEventListener("change", (event) => {
    if (event.matches) drawer(false);
  });

  // Each link carries its own heading and its own primary action, because the same
  // screen is called Users for a CEO and Staff for a manager.
  function go(screen) {
    const resolved = resolveScreen(state.persona, screen);
    if (resolved === null) return;
    state.screen = resolved;

    const link = all("[data-go]").find(
      (a) => a.dataset.go === resolved && a.offsetParent !== null
    );
    all("[data-go]").forEach((a) => a.classList.remove("on"));
    if (link) {
      link.classList.add("on");
      $("title").textContent = link.dataset.title;
    }

    const action = $("action");
    const wanted = primaryAction(resolved);
    action.hidden = wanted === null;
    if (wanted !== null) {
      action.textContent = wanted.label;
      action.dataset.opens = wanted.opens;
    }

    all(".view").forEach((view) => view.classList.remove("on"));
    $("v-" + resolved).classList.add("on");
    refresh(resolved);
  }

  // The heading's button belongs to the screen, and what it opens depends on who is
  // reading it. A CEO's Shops screen has no primary action -- opening a branch is not
  // theirs -- and an operator's does, because that is the one power selecting a
  // company grants.
  function primaryAction(screen) {
    if (screen === "companies") return { label: "Add company", opens: "company" };
    if (screen === "shops" && state.persona === "operator") {
      return { label: "Add branch", opens: "shop" };
    }
    if (screen === "users") {
      return state.persona === "manager"
        ? { label: "Add staff", opens: "staff" }
        : { label: "Add user", opens: "person" };
    }
    return null;
  }

  $("action").addEventListener("click", (event) => {
    const opens = event.currentTarget.dataset.opens;
    if (opens === "company") openCompanyDialog(null);
    if (opens === "shop") openShopDialog(null, { companyId: state.me.scope.companyId });
    if (opens === "person" || opens === "staff") openPersonDialog(null);
  });

  all("[data-go]").forEach((link) =>
    link.addEventListener("click", (event) => {
      event.preventDefault();
      go(link.dataset.go);
      if (!wide.matches) drawer(false);
    })
  );

  // -------------------------------------------------------------------------
  // The rail
  // -------------------------------------------------------------------------

  const scopeShopWrap = $("scope-shop-wrap");
  const scopeShop = $("scope-shop");

  function paintRail() {
    const user = state.me.user;
    $("me-nm").textContent = user.displayName;
    $("me-av").textContent = initials(user.displayName);
    $("me-ro").textContent = roleLabel(state.persona);

    if (state.persona === "platform") {
      $("scope-co").textContent = "Restaurant OS";
      $("scope-sh").textContent = "Platform";
      $("scope-sh").hidden = false;
      scopeShopWrap.hidden = true;
      return;
    }

    // From /me, not from the Companies list: a CEO can never read that list, and
    // for a platform admin the two are the same company anyway.
    $("scope-co").textContent = state.me.company ? state.me.company.name : "";

    // §3.0.1: two shops is a SWITCH, not a bigger screen. One shop and the line
    // simply names it; two and it becomes the control that says which one every
    // screen below is about.
    const mine = shopsIRun();
    if (state.persona === "manager" && mine.length > 1) {
      $("scope-sh").hidden = true;
      scopeShopWrap.hidden = false;
      fillSelect(scopeShop, mine.map((shop) => [shop.id, shop.name]));
      scopeShop.value = state.activeShopId || mine[0].id;
    } else {
      scopeShopWrap.hidden = true;
      $("scope-sh").hidden = false;
      $("scope-sh").textContent =
        state.persona === "operator"
          ? "Platform owner"
          : mine.length === 1
            ? mine[0].name
            : roleLabel(state.persona);
    }
  }

  function shopsIRun() {
    const ids = state.me.scope.shopIds || [];
    return state.shops.filter((shop) => ids.includes(shop.id));
  }

  function activeShop() {
    const mine = shopsIRun();
    if (mine.length === 0) return null;
    return mine.find((shop) => shop.id === state.activeShopId) || mine[0];
  }

  scopeShop.addEventListener("change", () => {
    state.activeShopId = scopeShop.value;
    refresh(state.screen);
  });

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  // Each screen fetches what it draws, on arrival. Refetching after every write is
  // deliberate: the server is the record, and a client that patches its own copy is
  // a second record that is right until it is not.
  async function refresh(screen) {
    if (screen === "companies") await loadCompanies();
    // EVERY screen, not just the ones that draw a shop. The rail names the shop a
    // manager is looking at, and a rail that says "Manager" on Dashboard and names
    // the shop on Settings is two different answers to "where am I". The lists are
    // small and the read is one request.
    if (state.persona !== "platform") await loadTenant();
    if (screen === "account") await loadAccount();
    paintRail();
    paint(screen);
  }

  async function loadCompanies() {
    const result = await send(() => api.listCompanies({ status: "all" }));
    if (result && result.state === "ok") state.companies = result.data.companies;
  }

  async function loadTenant() {
    const [shops, users] = await Promise.all([
      send(() => api.listShops({ status: "all" })),
      send(() => api.listUsers({ status: "all" }))
    ]);
    if (shops && shops.state === "ok") state.shops = shops.data.shops;
    // A manager may list only their own people, and staff may list nobody. A refusal
    // here is the shape of the role, not an error to put on the screen.
    if (users && users.state === "ok") state.users = users.data.users;
    if (state.activeShopId === null) {
      const mine = shopsIRun();
      state.activeShopId = mine.length > 0 ? mine[0].id : null;
    }
  }

  async function loadAccount() {
    if (state.persona === "platform") {
      const result = await send(() => api.listPlatformAdmins({}));
      if (result && result.state === "ok") {
        state.self = result.data.admins.find((a) => a.id === state.me.user.id) || null;
      }
      return;
    }
    if (state.persona === "operator") {
      // The platform-admin routes want an UNSCOPED platform admin, and this one is
      // standing inside a company. Rather than quietly dropping their scope under
      // them, the screen says so and offers the button that does it.
      state.self = null;
      return;
    }
    const result = await send(() => api.getUser(state.me.user.id));
    if (result && result.state === "ok") state.self = result.data;
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  function paint(screen) {
    if (screen === "companies") paintCompanies();
    if (screen === "shops") paintShops();
    if (screen === "users") paintUsers();
    if (screen === "settings") paintSettings();
    if (screen === "account") paintAccount();
    tagCardLines();
  }

  const cell = (text, { label, className = "" } = {}) => {
    const td = document.createElement("td");
    td.className = ["meta", "state", className].filter(Boolean).join(" ");
    if (label) td.dataset.label = label;
    td.textContent = text;
    return td;
  };

  // "<b>Name</b>address" -- a bold line and a quieter one under it, which is what
  // every people-shaped column in these tables is.
  function twoLine(name, detail, label) {
    const td = cell("", { label });
    const strong = document.createElement("b");
    strong.textContent = name;
    td.append(strong);
    if (detail) td.append(detail);
    return td;
  }

  function whoCell(name, sub) {
    const td = document.createElement("td");
    const who = document.createElement("div");
    who.className = "who";
    const avatar = document.createElement("span");
    avatar.className = "av";
    avatar.textContent = initials(name);
    const stack = document.createElement("span");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = name;
    stack.append(nm);
    if (sub) {
      stack.append(document.createElement("br"));
      const em = document.createElement("span");
      em.className = "em";
      em.textContent = sub;
      stack.append(em);
    }
    who.append(avatar, stack);
    td.append(who);
    return td;
  }

  function actionsCell(buttons) {
    const td = document.createElement("td");
    td.className = "act";
    for (const [text, onClick, className] of buttons) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className || "edit";
      button.textContent = text;
      button.addEventListener("click", onClick);
      td.append(button);
    }
    return td;
  }

  // On a phone the card shows the first column after the name -- the one that says
  // what this row IS -- plus the status when it is not the ordinary one. Marked here
  // rather than in the markup because each table's first column is different: CEO,
  // Manager, Role.
  function tagCardLines() {
    for (const row of all("tbody tr")) {
      const first = row.querySelector("td.meta");
      if (first) first.classList.add("m-key");
      const shop = row.querySelector('[data-label="Shop"]');
      if (shop && shop !== first) shop.classList.add("m-key2");
      const status = row.querySelector('[data-label="Status"]');
      if (status) status.classList.add("m-state");
      row.classList.toggle("lean", first === status || !first);
    }
  }

  const say = (element, text) => {
    if (!element) return;
    element.textContent = text || "";
    element.hidden = !text;
  };

  // A confirmation that clears itself. It says the write landed, and then stops
  // saying it -- a "Saved" line still on the screen ten minutes later is describing
  // the wrong thing by then.
  let fading = null;
  function confirm(element, text) {
    say(element, text);
    clearTimeout(fading);
    fading = setTimeout(() => say(element, ""), 4000);
  }

  // ---- Companies (the platform owner's only list) -------------------------

  function paintCompanies() {
    const body = $("co-rows");
    body.textContent = "";
    for (const company of state.companies) {
      const row = document.createElement("tr");
      row.append(whoCell(company.name, company.slug));
      row.append(
        company.ceo
          ? twoLine(company.ceo.displayName, company.ceo.email, "CEO")
          : cell("No CEO yet", { label: "CEO", className: "gap" })
      );
      row.append(cell(String(company.shopCount), { label: "Shops" }));
      row.append(cell(String(company.tableCount), { label: "Tables" }));
      row.append(
        cell(company.status === "active" ? "Active" : "Suspended", {
          label: "Status",
          className: company.status === "active" ? "ok" : ""
        })
      );
      row.append(
        actionsCell([
          // §4A.1: a branch is added from inside the company it belongs to. Opening
          // the company is what makes every branch-shaped action reachable.
          ["Open", () => enterCompany(company)],
          ["Edit", () => openCompanyDialog(company)]
        ])
      );
      body.append(row);
    }
    if (state.companies.length === 0) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "blank";
      td.textContent = "No companies yet.";
      row.append(td);
      body.append(row);
    }
  }

  // Selecting a company turns the platform owner into the operator -- the persona
  // that can open a branch and appoint the people inside it. The rail changes under
  // them, which is the honest signal that they are no longer above every company.
  async function enterCompany(company) {
    const result = await send(() => api.selectScope(company.id));
    if (!result || result.state !== "ok") return;
    await rebootFromServer();
  }

  async function leaveCompany() {
    const result = await send(() => api.selectScope(null));
    if (!result || result.state !== "ok") return;
    await rebootFromServer();
  }

  // The session's scope changed, so everything derived from it is stale -- persona,
  // menu, shop list, the lot. Re-reading /me is cheaper than reasoning about which
  // parts survived.
  async function rebootFromServer() {
    const fresh = await send(() => api.me());
    if (!fresh || !fresh.me) return;
    state.me = fresh.me;
    state.persona = personaOf(fresh.me);
    state.shops = [];
    state.users = [];
    state.activeShopId = null;
    document.body.dataset.as = state.persona;
    go(resolveScreen(state.persona, state.screen));
  }

  // ---- Shops --------------------------------------------------------------

  function managerOf(shop) {
    return (
      state.users.find(
        (user) => user.role === "shop_manager" && (user.shopIds || []).includes(shop.id)
      ) || null
    );
  }

  // Joined here rather than counted by the server, because the CEO already holds
  // the whole list to draw the Users screen and a second endpoint would be a second
  // answer to the same question.
  function staffCount(shop) {
    return state.users.filter(
      (user) => user.role === "staff" && (user.shopIds || []).includes(shop.id)
    ).length;
  }

  function paintShops() {
    const body = $("shops-rows");
    body.textContent = "";
    for (const shop of state.shops) {
      const manager = managerOf(shop);
      const slot = managerState(shop, manager);
      const row = document.createElement("tr");
      row.append(whoCell(shop.name, shop.address || shop.slug));
      row.append(
        slot.kind === "person"
          ? twoLine(slot.label, slot.detail, "Manager")
          : cell(slot.label, { label: "Manager", className: slot.kind === "gap" ? "gap" : "" })
      );
      row.append(cell(String(shop.tableCount), { label: "Tables" }));
      row.append(cell(String(staffCount(shop)), { label: "Staff" }));
      row.append(
        cell(shop.status === "active" ? "Active" : "Suspended", {
          label: "Status",
          className: shop.status === "active" ? "ok" : ""
        })
      );
      row.append(actionsCell([["Edit", () => openShopDialog(shop, {})]]));
      body.append(row);
    }

    $("shop-none").hidden = state.shops.length > 0;

    // §3.1B: a shop with nobody in it is the CEO's to run, and the screen says so
    // rather than leaving them to work it out from an empty cell.
    const gaps = state.shops.filter((shop) => managerState(shop, managerOf(shop)).kind === "gap");
    say(
      $("shop-gap"),
      gaps.length === 0
        ? ""
        : gaps.length === 1
          ? `${gaps[0].name} has no manager yet. Until you appoint one, that shop is yours to run.`
          : `${gaps.length} branches have no manager yet. Until you appoint one, they are yours to run.`
    );
  }

  // ---- Users --------------------------------------------------------------

  const ROLE_TEXT = { company_admin: "Owner", shop_manager: "Manager", staff: "Staff" };

  function shopNames(ids) {
    return (ids || [])
      .map((id) => (state.shops.find((shop) => shop.id === id) || {}).name)
      .filter(Boolean)
      .join(", ");
  }

  function paintUsers() {
    if (state.persona === "manager") {
      paintStaffTable();
      return;
    }
    const body = $("ceo-rows");
    body.textContent = "";
    // A CEO's own row is not in their own list of people to manage: they cannot act
    // on themselves through it, and a row whose every button is refused is worse
    // than no row. Account settings is where their own record lives.
    const people = state.users.filter((user) => user.id !== state.me.user.id);
    for (const user of people) {
      const row = document.createElement("tr");
      row.append(whoCell(user.displayName, user.email));
      row.append(cell(ROLE_TEXT[user.role] || user.role, { label: "Role" }));
      row.append(cell(shopNames(user.shopIds) || "—", { label: "Shop" }));
      row.append(
        cell(user.status === "active" ? "Active" : "Suspended", {
          label: "Status",
          className: user.status === "active" ? "ok" : ""
        })
      );
      row.append(actionsCell([["Edit", () => openPersonDialog(user)]]));
      body.append(row);
    }
  }

  function paintStaffTable() {
    const body = $("staff-rows");
    body.textContent = "";
    const shop = activeShop();
    const here = state.users.filter(
      (user) =>
        user.role === "staff" && (!shop || (user.shopIds || []).includes(shop.id))
    );
    for (const user of here) {
      const row = document.createElement("tr");
      row.append(whoCell(user.displayName, user.email));
      row.append(
        cell(user.status === "active" ? "Active" : "Suspended", {
          label: "Status",
          className: user.status === "active" ? "ok" : ""
        })
      );
      row.append(actionsCell([["Edit", () => openPersonDialog(user)]]));
      body.append(row);
    }
  }

  // ---- Settings -----------------------------------------------------------

  function paintSettings() {
    if (state.persona === "company" || state.persona === "operator") {
      $("s1").value = state.me.company ? state.me.company.name : "";
      // Renaming a company is the platform owner's: §8A, because the name reaches
      // inside every branch below it. A CEO reads it here and asks.
      $("s1").disabled = true;
      return;
    }
    if (state.persona !== "manager") return;

    // §7A: the country facts are the platform owner's, set once when the branch was
    // opened. They are shown here because a manager needs to KNOW them -- and they
    // are disabled because a mis-click on a currency is a day of wrong receipts.
    const shop = activeShop();
    if (!shop) return;
    $("m1").value = shop.name;
    $("m-tz").value = shop.timeZone;
    $("m-cur").value = labelFor(CURRENCIES, shop.currency);
    $("m-lang").value = labelFor(LANGUAGES, shop.language);
    $("m2").value = shop.phone || "";
    $("m3").value = shop.openingHours || "";
    $("m4").value = shop.receiptFooter || "";
  }

  // The day-to-day three are the manager's, and saving them is a PATCH of only what
  // changed -- an empty patch is refused by the server, and sending all three every
  // time would write a field nobody touched.
  async function saveDayToDay() {
    const shop = activeShop();
    if (!shop) return;
    const changes = {};
    const wanted = {
      phone: $("m2").value.trim(),
      openingHours: $("m3").value.trim(),
      receiptFooter: $("m4").value.trim()
    };
    for (const [key, value] of Object.entries(wanted)) {
      if (value !== (shop[key] || "")) changes[key] = value === "" ? null : value;
    }
    if (Object.keys(changes).length === 0) return;
    const result = await send(() => api.updateShopDayToDay(shop.id, changes));
    if (!result) return;
    if (result.state !== "ok") {
      say($("m-warn"), describeFailure(result));
      return;
    }
    say($("m-warn"), "");
    confirm($("m-done"), "Saved.");
    await refresh("settings");
  }

  for (const id of ["m2", "m3", "m4"]) {
    const field = $(id);
    if (field) field.addEventListener("change", saveDayToDay);
  }

  // ---- Account ------------------------------------------------------------

  function paintAccount() {
    const self = state.self;
    $("a1").value = state.me.user.displayName;
    $("a2").value = state.me.user.email;
    $("a4").value = self ? self.phone || "" : "";

    const language = $("a5");
    // §7A.3: "following my shop" is a real choice and it is the DEFAULT, so it is
    // the first option rather than a blank one. Storing the resolved code instead
    // would silently break the link the day the shop's language changed.
    const shop = activeShop();
    const inherited = shop ? labelFor(LANGUAGES, shop.language) : null;
    fillSelect(language, LANGUAGES, {
      placeholder: inherited ? `Follow this shop — ${inherited}` : "Follow the default"
    });
    language.value = self && self.language ? self.language : "";
    say(
      $("a5-note"),
      inherited
        ? "Only what you read. Everyone else here keeps their own."
        : "Only what you read."
    );

    const editable = state.persona !== "operator";
    $("a1").disabled = !editable;
    $("a4").disabled = !editable;
    language.disabled = !editable;
    say(
      $("a1-note"),
      editable
        ? "How you appear to everyone else."
        : "Leave the company you are working inside to edit your own account."
    );
  }

  // Saved on change rather than behind a Save button: each of these is one field,
  // and a form that needs a button to commit one field invents a state where the
  // screen and the record disagree.
  async function saveSelf(changes) {
    if (state.persona === "operator") return;
    const call =
      state.persona === "platform"
        ? () => api.updatePlatformAdmin(state.me.user.id, changes)
        : () => api.updateUser(state.me.user.id, changes);
    const result = await send(call);
    if (!result) return;
    if (result.state !== "ok") {
      say($("a1-note"), describeFailure(result));
      return;
    }
    if (changes.displayName) {
      state.me.user.displayName = changes.displayName;
      paintRail();
    }
    await refresh("account");
  }

  $("a1").addEventListener("change", () => saveSelf({ displayName: $("a1").value.trim() }));
  $("a4").addEventListener("change", () => saveSelf({ phone: $("a4").value.trim() || null }));
  $("a5").addEventListener("change", () =>
    // A platform admin has no shop to follow, and their route does not take a
    // language at all, so the field is theirs to read and not to set.
    state.persona === "platform" ? undefined : saveSelf({ language: $("a5").value || null })
  );

  // -------------------------------------------------------------------------
  // Dialogs
  // -------------------------------------------------------------------------

  function openModal(dialog) {
    dialog.showModal();
  }

  function closeModal(dialog) {
    dialog.close();
  }

  // The details sheet. A row carries a few columns; everything else about a record
  // lives here, so a phone number is one tap away rather than a column nobody has
  // room for.
  function showFacts(title, sub, rows) {
    $("info-h").textContent = title;
    $("info-sub").textContent = sub || "";
    const box = $("info-facts");
    box.textContent = "";
    for (const [key, value] of rows.filter((entry) => entry[1])) {
      const line = document.createElement("div");
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = key;
      const v = document.createElement("span");
      v.textContent = value;
      line.append(k, v);
      box.append(line);
    }
    $("info-edit").hidden = true;
    openModal($("info-dialog"));
  }

  $("info-close").addEventListener("click", () => closeModal($("info-dialog")));

  // ---- URL names ----------------------------------------------------------

  // The field explains itself by showing what it builds. A rule you can read is a
  // rule you do not have to be told twice.
  function wireSlug(nameInput, slugInput, urlLine, warnLine, base) {
    let touched = false;
    const paintIt = () => {
      const problem = slugProblem(slugInput.value);
      urlLine.textContent = slugInput.value ? `${base()}${slugInput.value}` : "";
      say(warnLine, slugInput.value === "" ? "" : problem);
    };
    nameInput.addEventListener("input", () => {
      // A suggestion until it is touched, and theirs from then on.
      if (!touched) slugInput.value = slugify(nameInput.value);
      paintIt();
    });
    slugInput.addEventListener("input", () => {
      touched = true;
      paintIt();
    });
    return {
      reset(value) {
        touched = value !== "";
        slugInput.value = value;
        paintIt();
      },
      problem: () => slugProblem(slugInput.value)
    };
  }

  // ---- the company dialog -------------------------------------------------

  const coDialog = $("co-dialog");
  const coSlug = wireSlug($("co-name"), $("co-slug"), $("co-slug-url"), $("co-slug-warn"), () => "app/");
  let coEditing = null;
  let coReplacing = false;

  function openCompanyDialog(company) {
    coEditing = company;
    $("co-h").textContent = company ? "Edit company" : "Add company";
    $("co-save").textContent = company ? "Save" : "Add company";
    $("co-sub").textContent = company
      ? company.name
      : "Every company starts with one CEO.";
    $("co-name").value = company ? company.name : "";
    coSlug.reset(company ? company.slug : "");

    $("co-status-box").hidden = !company;
    if (company) {
      const wanted = company.status === "active" ? "active" : "suspended";
      for (const radio of all('input[name="co-status"]', coDialog)) {
        radio.checked = radio.value === wanted;
      }
    }

    // Two shapes, and which one is showing depends on whether the company already
    // has a CEO. Appointing collects the three person fields; an existing CEO is
    // named, with the two things that can be done to them from out here.
    coReplacing = false;
    paintCeoBlock();
    $("co-pname").value = "";
    $("co-pemail").value = "";
    $("co-pphone").value = "";
    $("co-pw-field").hidden = true;
    $("co-out").hidden = true;
    say($("co-slug-warn"), "");
    say($("co-phone-warn"), "");
    say($("co-reset-out"), "");
    openModal(coDialog);
  }

  function paintCeoBlock() {
    const ceo = coEditing && coEditing.ceo;
    const appointing = !coEditing || ceo === null || coReplacing;
    $("co-person").hidden = !appointing;
    $("co-ceo").hidden = !ceo;
    if (ceo) $("co-ceo-who").textContent = `${ceo.displayName} · ${ceo.email}`;
    // Only when a replacement is being appointed, because only then is there an
    // outgoing person for the question to be about.
    $("co-out").hidden = !(ceo && coReplacing);
    if (ceo && coReplacing) $("co-out-who").textContent = ceo.displayName;
    $("co-pname-l").textContent = coReplacing ? "New CEO name" : "CEO name";
    $("co-pemail-l").textContent = coReplacing ? "New CEO sign-in email" : "CEO sign-in email";
  }

  // §5.1: read out loud, never mailed. The platform owner is the only person above
  // a CEO, so when a CEO is locked out this button is the whole recovery path.
  $("co-reset").addEventListener("click", async () => {
    if (!coEditing || !coEditing.ceo) return;
    const result = await insideCompany(coEditing.id, () =>
      send(() => api.resetUserPassword(coEditing.ceo.id))
    );
    if (!result || result.state !== "ok") {
      say($("co-phone-warn"), result ? describeFailure(result) : "");
      return;
    }
    say($("co-reset-out"), `New password: ${result.data.initialPassword} — read it out now.`);
  });

  $("co-replace").addEventListener("click", () => {
    coReplacing = true;
    paintCeoBlock();
    $("co-pname").focus();
  });

  $("co-cancel").addEventListener("click", () => closeModal(coDialog));

  $("co-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("co-save");
    button.disabled = true;
    try {
      const problem = coSlug.problem();
      if (problem) {
        say($("co-slug-warn"), problem);
        return;
      }
      const name = $("co-name").value.trim();
      const slug = $("co-slug").value.trim();

      if (coEditing) {
        const status = (all('input[name="co-status"]', coDialog).find((r) => r.checked) || {}).value;
        const result = await send(() => api.updateCompany(coEditing.id, { name, slug, status }));
        if (!result) return;
        if (result.state !== "ok") {
          say($("co-slug-warn"), describeFailure(result));
          return;
        }

        // The company saved. Whether a person changed hands is a separate question
        // with a separate answer, and it is asked second so a failure here does not
        // undo the rename that already worked.
        const appointing = coEditing.ceo === null || coReplacing;
        if (appointing) {
          const ceo = await appointCeo(coEditing.id, coReplacing ? coEditing.ceo : null);
          await refresh("companies");
          if (ceo.done) {
            showFirstPassword($("co-ppw"), $("co-pw-field"), ceo.password);
            $("co-sub").textContent = "Read this password out. It is not shown again.";
            return;
          }
          if (ceo.failed) return;
        }
        closeModal(coDialog);
        confirm($("co-done"), "Saved.");
        await refresh("companies");
        return;
      }

      const created = await send(() => api.createCompany({ name, slug }));
      if (!created) return;
      if (created.state !== "ok") {
        say($("co-slug-warn"), describeFailure(created));
        return;
      }

      // Two writes, and the second can fail on its own. That is not hidden: the
      // company exists, the Companies row says "No CEO yet", and the same dialog
      // reopened offers only the half that is still missing. A rollback would throw
      // away a company that was created exactly as asked.
      const ceo = await appointCeo(created.data.id);
      await refresh("companies");
      if (ceo.done) {
        showFirstPassword($("co-ppw"), $("co-pw-field"), ceo.password);
        $("co-sub").textContent = "Read this password out. It is not shown again.";
        return;
      }
      // The company IS created either way -- the dialog reopens on it rather than on
      // a blank form, so a second attempt at the CEO is one field away and does not
      // try to create the company again.
      if (ceo.failed) {
        coEditing = state.companies.find((c) => c.id === created.data.id) || null;
        $("co-h").textContent = "Edit company";
        $("co-save").textContent = "Save";
        $("co-status-box").hidden = false;
        return;
      }
      closeModal(coDialog);
      confirm($("co-done"), "Company created.");
    } finally {
      button.disabled = false;
    }
  });

  // Three outcomes, and they are three different things the caller must do:
  //   {done:false}            nothing was asked for -- close, the company is saved
  //   {done:true, password}   appointed -- stay open, the password is on screen
  //   {done:false, failed:true} refused -- STAY OPEN, the reason is on the dialog
  // Collapsing the last two into null is how a 422 ends up behind a closed dialog
  // with the company created and nobody able to say why the CEO is missing.
  async function appointCeo(companyId, outgoing) {
    const displayName = $("co-pname").value.trim();
    const email = $("co-pemail").value.trim();
    const phone = $("co-pphone").value.trim();
    if (!displayName || !email) return { done: false };

    const answer = (all('input[name="ceo-out"]', coDialog).find((r) => r.checked) || {}).value;

    const result = await insideCompany(companyId, async () => {
      // No shopIds AT ALL, not an empty one and not null. A CEO is company-wide, and
      // the route reads an absent key as that -- while a present key is a claim about
      // which shops they reach, which for this role is refused whatever it holds.
      const created = await send(() =>
        api.createUser({ email, displayName, phone, role: "company_admin" })
      );
      if (!created || created.state !== "ok") return created;

      // The outgoing CEO is dealt with AFTER the new one exists, never before. The
      // other order leaves a company with nobody who can sign in if the second call
      // fails, and this one leaves it with two -- which the Companies row shows and
      // a second edit fixes.
      if (outgoing && answer === "suspend") {
        await send(() => api.updateUser(outgoing.id, { status: "suspended" }));
      }
      return created;
    });

    if (!result || result.state !== "ok") {
      say($("co-phone-warn"), result ? describeFailure(result) : "");
      return { done: false, failed: true };
    }
    return { done: true, password: result.data.initialPassword };
  }

  // §5.1: read out loud, never mailed -- this system has no mail server. The field
  // is the handover, so it stays on screen until the dialog is closed deliberately.
  function showFirstPassword(input, field, password) {
    input.value = password;
    field.hidden = false;
  }

  // ---- the shop dialog ----------------------------------------------------

  const shopDialog = $("shop-dialog");
  const shSlug = wireSlug($("sh-name"), $("sh-slug"), $("sh-slug-url"), $("sh-slug-warn"), () => {
    return `app/${state.me.company ? state.me.company.slug : "company"}/`;
  });
  let shEditing = null;

  function openShopDialog(shop, { companyId } = {}) {
    shEditing = shop;
    const opening = shop === null;
    const owner = state.persona === "operator" || state.persona === "platform";

    $("shop-h").textContent = opening ? "Open a branch" : "Edit shop";
    $("shop-sub").textContent = opening ? "" : shop.name;
    $("shop-save").textContent = opening ? "Open branch" : "Save";

    $("sh-name").value = opening ? "" : shop.name;
    shSlug.reset(opening ? "" : shop.slug);
    $("sh-addr").value = opening ? "" : shop.address || "";

    // §8A: what the branch IS -- its name, its address, its URL -- belongs to the
    // platform owner, because a rename reaches inside the company. A CEO reads these
    // and cannot type into them. Leaving them editable and dropping the values on
    // save is the worse version of the same rule: the screen agrees, and the record
    // does not.
    for (const id of ["sh-name", "sh-slug", "sh-addr"]) $(id).disabled = !owner;

    // §4A.1: tables are set when the branch is opened and are the size of the room.
    // Changing the count later is not a rename, so the field only exists here.
    $("sh-tables-field").hidden = !opening;
    $("sh-tables").value = opening ? "" : "";
    $("sh-tables-hint").textContent = "They are numbered 1 to N. You can add more later.";

    // §7A: the country facts belong to the platform owner and are set ONCE, when
    // the branch is opened. A CEO reads them in Settings and cannot touch them --
    // "they aren't frequently changed, and a mis-click messes the system up".
    fillSelect($("sh-tz"), TIME_ZONES.map((zone) => [zone, zone]), { placeholder: "Choose one…" });
    fillSelect($("sh-cur"), CURRENCIES, { placeholder: "Choose one…" });
    fillSelect($("sh-lang"), LANGUAGES, { placeholder: "Choose one…" });
    $("sh-country").hidden = !opening;
    if (!opening) {
      $("sh-tz").value = shop.timeZone;
      $("sh-cur").value = shop.currency;
      $("sh-lang").value = shop.language;
    }

    // The country facts as FACTS, for the reader who cannot change them. A CEO
    // needs to know what currency their branch prints in even though setting it is
    // not theirs, and an empty disabled select says less than a line of text.
    const facts = $("sh-facts");
    facts.textContent = "";
    facts.hidden = opening || owner;
    if (!facts.hidden) {
      for (const [key, value] of [
        ["Time zone", shop.timeZone],
        ["Currency", labelFor(CURRENCIES, shop.currency)],
        ["Language", labelFor(LANGUAGES, shop.language)],
        ["Tables", String(shop.tableCount)]
      ]) {
        const line = document.createElement("div");
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = key;
        const v = document.createElement("span");
        v.textContent = value;
        line.append(k, v);
        facts.append(line);
      }
    }

    // The manager slot is the CEO's, and only the CEO's. A platform admin may open a
    // branch and may not staff it -- the route refuses them by name, and a field
    // they could fill in and not save would be a worse way to learn that.
    $("sh-mgr-field").hidden = opening || owner;
    if (!opening && !owner) paintManagerChoices(shop);

    // §3.1B: the day-to-day three belong to whoever runs the place, and when the
    // shop has no manager that is the CEO. A shop with a manager keeps them out of
    // it -- the manager owns their own receipt footer.
    const slot = opening ? null : managerState(shop, managerOf(shop));
    const ceoRuns = !opening && !owner && slot.kind !== "person";
    $("sh-day").hidden = !ceoRuns;
    if (ceoRuns) {
      $("sh-day-why").textContent =
        slot.kind === "owner"
          ? "You run this shop, so these are yours."
          : "Nobody manages this shop yet, so these are yours until somebody does.";
      $("sh-phone").value = shop.phone || "";
      $("sh-hours").value = shop.openingHours || "";
      $("sh-footer").value = shop.receiptFooter || "";
    }

    $("sh-limit").textContent = owner
      ? "You open the branch and set what its country needs. Who runs it is the CEO's to decide."
      : "The branch itself — its name, address and table count — is the platform owner's.";

    $("handover").hidden = true;
    say($("sh-name-warn"), "");
    say($("sh-country-warn"), "");
    say($("sh-slug-warn"), "");
    shopDialog.dataset.companyId = companyId || state.me.scope.companyId || "";
    openModal(shopDialog);
  }

  // §3.0: a manager may hold two shops, so the list is everyone who could run one --
  // not everyone who is free.
  function paintManagerChoices(shop) {
    const current = managerOf(shop);
    const candidates = state.users.filter(
      (user) => user.role === "shop_manager" || user.role === "staff"
    );
    const select = $("sh-mgr");
    fillSelect(
      select,
      [
        ["", "Nobody yet — still looking"],
        // §3.1A: the third state. "The owner runs it" is an answer, not a gap, and
        // it is the small-shop case where the CEO and the manager are one person.
        ["__owner", "I run this shop myself"],
        ...candidates.map((user) => [user.id, `${user.displayName} · ${user.email}`])
      ]
    );
    select.value = current ? current.id : shop.runByOwner ? "__owner" : "";

    select.onchange = () => {
      const replacing = current && select.value !== current.id;
      $("handover").hidden = !replacing;
      if (replacing) $("handover-who").textContent = current.displayName;
    };
  }

  $("shop-cancel").addEventListener("click", () => closeModal(shopDialog));

  $("shop-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("shop-save");
    button.disabled = true;
    try {
      if (shEditing === null) {
        await openBranch();
        return;
      }
      await saveBranch();
    } finally {
      button.disabled = false;
    }
  });

  async function openBranch() {
    if ($("sh-name").value.trim() === "") {
      say($("sh-name-warn"), "A branch needs a name.");
      return;
    }
    say($("sh-name-warn"), "");
    const problem = shSlug.problem();
    if (problem) {
      say($("sh-slug-warn"), problem);
      return;
    }
    const input = {
      name: $("sh-name").value.trim(),
      slug: $("sh-slug").value.trim(),
      address: $("sh-addr").value.trim() || null,
      timeZone: $("sh-tz").value,
      currency: $("sh-cur").value,
      language: $("sh-lang").value,
      businessDayRolloverHour: 6,
      tableCount: Number($("sh-tables").value || 0)
    };
    if (!input.timeZone || !input.currency || !input.language) {
      say($("sh-country-warn"), "A branch needs all three before it can open.");
      return;
    }
    const companyId = shopDialog.dataset.companyId;
    const run = () => send(() => api.createShop(input));
    const result =
      state.persona === "operator" ? await run() : await insideCompany(companyId, run);
    if (!result) return;
    if (result.state !== "ok") {
      say($("sh-country-warn"), describeFailure(result));
      return;
    }
    closeModal(shopDialog);
    confirm($(state.screen === "companies" ? "co-done" : "shop-done"), "Branch opened.");
    await refresh(state.screen);
  }

  async function saveBranch() {
    const owner = state.persona === "operator" || state.persona === "platform";
    if (owner) {
      const problem = shSlug.problem();
      if (problem) {
        say($("sh-slug-warn"), problem);
        return;
      }
      const result = await send(() =>
        api.updateShop(shEditing.id, {
          name: $("sh-name").value.trim(),
          slug: $("sh-slug").value.trim(),
          address: $("sh-addr").value.trim() || null
        })
      );
      if (!result) return;
      if (result.state !== "ok") {
        say($("sh-slug-warn"), describeFailure(result));
        return;
      }
      closeModal(shopDialog);
      confirm($("shop-done"), "Saved.");
      await refresh(state.screen);
      return;
    }

    // The CEO's half: the manager slot, and the day-to-day three when the shop is
    // theirs to run. PUT, not PATCH -- the slot is REPLACED, and the body always
    // says which of the three states the shop is being left in.
    const chosen = $("sh-mgr").value;
    const outgoing = (all('input[name="handover"]', shopDialog).find((r) => r.checked) || {}).value;
    const body = {
      managerUserId: chosen === "" || chosen === "__owner" ? null : chosen,
      runByOwner: chosen === "__owner"
    };
    if (!$("handover").hidden) body.outgoing = outgoing === "suspend" ? "suspend" : "staff";

    const result = await send(() => api.setShopManager(shEditing.id, body));
    if (!result) return;
    if (result.state !== "ok") {
      say($("sh-slug-warn"), describeFailure(result));
      return;
    }

    if (!$("sh-day").hidden) {
      const changes = {};
      const wanted = {
        phone: $("sh-phone").value.trim(),
        openingHours: $("sh-hours").value.trim(),
        receiptFooter: $("sh-footer").value.trim()
      };
      for (const [key, value] of Object.entries(wanted)) {
        if (value !== (shEditing[key] || "")) changes[key] = value === "" ? null : value;
      }
      if (Object.keys(changes).length > 0) {
        await send(() => api.updateShopDayToDay(shEditing.id, changes));
      }
    }

    closeModal(shopDialog);
    confirm($("shop-done"), "Saved.");
    await refresh(state.screen);
  }

  // ---- the person dialog --------------------------------------------------

  const staffDialog = $("staff-dialog");
  let stEditing = null;

  function openPersonDialog(user) {
    stEditing = user;
    const adding = user === null;
    const asManager = state.persona === "manager";

    $("staff-h").textContent = adding
      ? asManager
        ? "Add staff"
        : "Add user"
      : user.displayName;
    $("staff-save").textContent = adding ? "Add" : "Save";
    $("staff-sub").textContent = asManager ? (activeShop() || {}).name || "" : "";

    $("st-name").value = adding ? "" : user.displayName;
    $("st-email").value = adding ? "" : user.email;
    // §6.2: an email is a sign-in name. Changing it is how somebody quietly takes
    // over an account, so it is set once, at the point the account is created.
    $("st-email").disabled = !adding;
    $("st-phone").value = adding ? "" : user.phone || "";

    // A manager appoints staff into the shop they are standing in, so there is
    // nothing to choose. A CEO chooses, because they hold all of them.
    const shopField = $("st-shop-field");
    shopField.hidden = asManager;
    if (!asManager) {
      fillSelect($("st-shop"), state.shops.map((shop) => [shop.id, shop.name]));
      const held = (user && user.shopIds) || [];
      if (held.length > 0) $("st-shop").value = held[0];
    }

    $("st-temp-field").hidden = true;
    $("st-access").hidden = adding;
    if (!adding) {
      for (const radio of all('input[name="access"]', staffDialog)) {
        radio.checked = radio.value === (user.status === "active" ? "active" : "suspended");
      }
    }
    $("st-reset").hidden = adding;
    $("st-limit").textContent = asManager
      ? "Only your CEO can make someone a manager or move them to another shop."
      : "A person you add here signs in with the password you read out to them.";
    openModal(staffDialog);
  }

  $("staff-cancel").addEventListener("click", () => closeModal(staffDialog));

  $("staff-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("staff-save");
    button.disabled = true;
    try {
      const asManager = state.persona === "manager";
      if (stEditing === null) {
        const shop = asManager ? activeShop() : { id: $("st-shop").value };
        const result = await send(() =>
          api.createUser({
            email: $("st-email").value.trim(),
            displayName: $("st-name").value.trim(),
            phone: $("st-phone").value.trim(),
            role: "staff",
            shopIds: shop ? [shop.id] : []
          })
        );
        if (!result) return;
        if (result.state !== "ok") {
          say($("st-phone-warn"), describeFailure(result));
          return;
        }
        showFirstPassword($("st-temp"), $("st-temp-field"), result.data.initialPassword);
        $("staff-sub").textContent = "Read this password out. It is not shown again.";
        await refresh("users");
        return;
      }

      const status = (all('input[name="access"]', staffDialog).find((r) => r.checked) || {}).value;
      const changes = {
        displayName: $("st-name").value.trim(),
        phone: $("st-phone").value.trim(),
        status
      };
      if (!asManager) changes.shopIds = [$("st-shop").value];
      const result = await send(() => api.updateUser(stEditing.id, changes));
      if (!result) return;
      if (result.state !== "ok") {
        say($("st-phone-warn"), describeFailure(result));
        return;
      }
      closeModal(staffDialog);
      confirm($(state.persona === "manager" ? "staff-done" : "ceo-done"), "Saved.");
      await refresh("users");
    } finally {
      button.disabled = false;
    }
  });

  $("st-reset-btn").addEventListener("click", async () => {
    if (!stEditing) return;
    const result = await send(() => api.resetUserPassword(stEditing.id));
    if (!result || result.state !== "ok") return;
    showFirstPassword($("st-temp"), $("st-temp-field"), result.data.initialPassword);
    $("st-reset-hint").textContent = "Read it out. It is not shown again.";
  });

  // -------------------------------------------------------------------------
  // Signing out
  // -------------------------------------------------------------------------

  for (const [id, everywhere] of [["signOut", false], ["signOutAll", true]]) {
    $(id).addEventListener("click", async () => {
      await api.logout(everywhere);
      onSignedOut();
    });
  }

  // The way back out of a company, for the one persona that got in deliberately.
  // Without it a platform admin who selected a company has no route back to the
  // Companies list except signing out.
  const leave = document.createElement("button");
  leave.type = "button";
  leave.className = "ghost leave";
  leave.textContent = "Back to platform";
  leave.addEventListener("click", leaveCompany);
  leave.dataset.for = "operator";
  $("scope-co").parentElement.append(leave);

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  document.body.dataset.as = state.persona;
  $("signedIn").hidden = false;
  go("dashboard");

  return {
    // Handed back so the shell can put the console away again on sign-out without
    // reaching into its DOM.
    unmount() {
      $("signedIn").hidden = true;
      delete document.body.dataset.as;
    }
  };
}
