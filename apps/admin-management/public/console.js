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
    contacts: [],
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
  async function borrowOnce(companyId, run) {
    const entered = await send(() => api.selectScope(companyId));
    if (entered === null) return null;
    if (entered.state !== "ok") return entered;
    try {
      return await run();
    } finally {
      await api.selectScope(null);
    }
  }

  // ONE AT A TIME. There is a single session scope, and two borrows racing for it
  // means the first one's restore lands inside the second one's window -- so the
  // second request arrives unscoped and is refused. Expanding two company rows in a
  // row on a slow connection did exactly that, and the second company showed a raw
  // refusal instead of the branches it has.
  let borrowQueue = Promise.resolve();
  function insideCompany(companyId, run) {
    const mine = borrowQueue.then(() => borrowOnce(companyId, run));
    // Swallowed on the QUEUE only, never on the returned promise: one failed borrow
    // must not stop every later one, and the caller still sees its own rejection.
    borrowQueue = mine.then(() => {}, () => {});
    return mine;
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
    // STAFF for everybody below the platform owner. What differs between a CEO and a
    // manager is WHO the list holds, not what the people in it are called.
    if (screen === "users") return { label: "Add staff", opens: "staff" };
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

  // The shops a person WORKS IN, which is not the same as the shops they can reach.
  // A company_admin's scope carries every active shop in the company -- that is reach
  // -- so a CEO of a one-branch company had the branch's name printed in the rail
  // where their role belongs, reading as that branch's manager, and their Account
  // language claimed to follow a branch they belong to none of.
  function shopsIRun() {
    if (state.persona !== "manager" && state.persona !== "staff") return [];
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
    if (screen === "contacts") await loadContacts();
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

  async function loadContacts() {
    const result = await send(() => api.listContacts());
    if (result && result.state === "ok") state.contacts = result.data.contacts;
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
    if (screen === "contacts") paintContacts();
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
  // Keyed on the ELEMENT. One shared handle meant the second confirmation cancelled
  // the first one's timer and adopted it, so the first "Saved." was never cleared --
  // the exact thing this function exists to prevent.
  const fading = new WeakMap();
  function confirm(element, text) {
    if (!element) return;
    say(element, text);
    clearTimeout(fading.get(element));
    fading.set(element, setTimeout(() => say(element, ""), 4000));
  }

  // ---- Companies (the platform owner's only list) -------------------------

  function paintCompanies() {
    const body = $("co-rows");
    body.textContent = "";
    expandedCompanyId = null;
    for (const company of state.companies) {
      const row = document.createElement("tr");
      row.dataset.companyId = company.id;
      // §4A.1: a branch is added from INSIDE the company it belongs to, and the
      // company row is where it starts -- a shop cannot exist without one. The row
      // opens into its branches, and the last thing hanging off the trunk is the way
      // to add to it.
      row.append(discloseCell(company));
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
          // "Open" hands the whole company over -- the operator persona, with its
          // Shops and Users screens. Opening one branch does not need that, which is
          // why the row expands as well as offering this.
          ["Open", () => enterCompany(company)],
          ["Edit", () => openCompanyDialog(company)]
        ])
      );
      // A click anywhere that is not one of those buttons opens the branches. The
      // buttons stop the event themselves, so the row does not have to know them.
      row.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        toggleBranches(company);
      });
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

  // The company cell, with the disclosure triangle in front of it. A real <button>,
  // not a styled span: the branches -- and the only route to creating a shop -- have
  // to be reachable from a keyboard.
  function discloseCell(company) {
    const td = whoCell(company.name, company.slug);
    const disc = document.createElement("button");
    disc.type = "button";
    disc.className = "disc";
    disc.setAttribute("aria-expanded", "false");
    disc.setAttribute("aria-label", `Branches of ${company.name}`);
    disc.addEventListener("click", () => toggleBranches(company));
    td.querySelector(".who").prepend(disc);
    return td;
  }

  // ---- a company's branches, opened from its row --------------------------

  let expandedCompanyId = null;

  function collapseBranches() {
    for (const sub of all("#co-rows tr.sub")) sub.remove();
    for (const open of all("#co-rows tr.open")) {
      open.classList.remove("open");
      const disc = open.querySelector(".disc");
      if (disc) disc.setAttribute("aria-expanded", "false");
    }
    expandedCompanyId = null;
  }

  // The platform owner is above every company and inside none of them, so reading one
  // company's shops means borrowing its scope for the read. That is why this happens
  // on a deliberate click rather than for every row at once: it is a request per
  // company, not a column the list could have carried.
  async function toggleBranches(company) {
    const wasOpen = expandedCompanyId === company.id;
    collapseBranches();
    if (wasOpen) return;

    const row = all("#co-rows tr").find((tr) => tr.dataset.companyId === company.id);
    if (!row) return;
    row.classList.add("open");
    const disc = row.querySelector(".disc");
    if (disc) disc.setAttribute("aria-expanded", "true");
    expandedCompanyId = company.id;

    const result = await insideCompany(company.id, () => send(() => api.listShops({ status: "all" })));
    // The row may have been collapsed, or the whole screen replaced, while the two
    // scope calls were in flight. Painting into it now would leave branches under a
    // row that is closed, or under the wrong company.
    if (expandedCompanyId !== company.id) return;
    if (!result || result.state !== "ok") {
      appendTwig(row, { text: describeFailure(result || { state: "unreachable" }) });
      appendAddBranch(row.nextElementSibling || row, company);
      return;
    }

    let at = row;
    for (const shop of result.data.shops) {
      // WHO TO RING, first, because that is what the platform owner opened this list
      // for: they fit the branch out, and when a screen on a table stops pairing
      // somebody has to answer the phone.
      //
      // A branch with no manager is NOT a dead end here. §3.1B: until the CEO
      // appoints one, that shop is theirs to run -- so the line says nobody manages
      // it yet AND names the CEO, who is the person actually running it. The same is
      // true of a shop the owner runs on purpose. Either way there is a name and a
      // number on the row.
      at = appendTwig(at, {
        name: shop.name,
        text: [contactFor(shop, company), shop.address, `${shop.tableCount} tables`]
          .filter(Boolean)
          .join("  ·  "),
        onOpen: () => openShopDialog(shop, { companyId: company.id })
      });
    }
    if (result.data.shops.length === 0) at = appendTwig(at, { text: "No branches yet." });
    appendAddBranch(at, company);
  }

  // paintCompanies() rebuilds every row, so a tree that was open before a write is
  // gone after it. Putting it back is the difference between "my branch was added"
  // and "the screen jumped and I have to find my company again".
  async function reopenBranches(companyId) {
    if (state.screen !== "companies" || !companyId) return;
    const company = state.companies.find((one) => one.id === companyId);
    if (company) await toggleBranches(company);
  }

  // "Thura Zaw · 09 ..." when somebody manages it, and otherwise the state it is in
  // followed by the CEO, who is who to ring instead. A row that said only "No manager
  // yet" would be telling the platform owner to go and ask somebody.
  function contactFor(shop, company) {
    const slot = managerState(shop, managerOf(shop));
    if (slot.kind === "person") {
      return [slot.label, shop.manager.phone].filter(Boolean).join(" · ");
    }
    const ceo = company.ceo;
    const standIn = ceo ? [ceo.displayName, ceo.phone].filter(Boolean).join(" · ") : "";
    if (!standIn) return slot.label;
    return `${slot.label} — ${standIn}`;
  }

  function appendTwig(after, { name, text, onOpen }) {
    const tr = document.createElement("tr");
    tr.className = "sub";
    const td = document.createElement("td");
    td.colSpan = 6;
    const twig = document.createElement("div");
    twig.className = "twig";

    const label = document.createElement("span");
    label.className = "twig-name";
    label.textContent = name || "";
    const meta = document.createElement("span");
    meta.className = "twig-meta";
    meta.textContent = text || "";
    twig.append(label, meta);

    if (onOpen) {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "twig-go";
      go.setAttribute("aria-label", `Edit ${name}`);
      twig.append(go);
      twig.addEventListener("click", onOpen);
    }

    td.append(twig);
    tr.append(td);
    after.after(tr);
    return tr;
  }

  // The last thing hanging off the trunk is the way to add to it, which also gives a
  // company with no branches at all one line -- and it is the line that fixes the
  // emptiness.
  function appendAddBranch(after, company) {
    const tr = appendTwig(after, { name: "Add branch", text: "" });
    tr.className = "sub twig-last";
    const twig = tr.querySelector(".twig");
    twig.classList.add("add");
    const plus = document.createElement("span");
    plus.className = "twig-plus";
    twig.prepend(plus);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "twig-go";
    go.setAttribute("aria-label", `Add a branch to ${company.name}`);
    twig.append(go);
    twig.addEventListener("click", () => openShopDialog(null, { companyId: company.id }));
    return tr;
  }

  // Selecting a company turns the platform owner into the operator -- the persona
  // that can open a branch and appoint the people inside it. The rail changes under
  // them, which is the honest signal that they are no longer above every company.
  async function enterCompany(company) {
    const result = await send(() => api.selectScope(company.id));
    if (!result) return;
    if (result.state !== "ok") {
      say($("scope-warn"), describeFailure(result));
      return;
    }
    await rebootFromServer();
  }

  // Crossing the boundary either way is a change of who you are, so a refusal has to
  // say so: nothing moved on screen, and "Back to platform" doing nothing reads as
  // being trapped inside somebody else's company.
  async function leaveCompany() {
    const result = await send(() => api.selectScope(null));
    if (!result) return;
    if (result.state !== "ok") {
      say($("scope-warn"), describeFailure(result));
      return;
    }
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

  // WHO, from the shop row, name and number included. Scanning the user list for a
  // manager was a derivation that depended on which hundred people came back: past
  // the cap a real manager read as "No manager yet", which raises the amber banner
  // and hands the CEO the day-to-day fields for a shop somebody else runs.
  //
  // Nothing here joins a user list any more, which is what lets the platform owner --
  // who has no user list at all -- read the same row and see the same person.
  function managerOf(shop) {
    return shop.manager || null;
  }

  // Counted by the server, for the same reason. The client-side join was right only
  // while everybody fitted in one page.
  function staffCount(shop) {
    return shop.staffCount;
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

  // ---- Contacts -----------------------------------------------------------

  // The one screen that is about REACHING somebody rather than administering them,
  // and the only one a member of staff has besides their own account. It carries no
  // Edit button anywhere: half these people outrank the person reading it.
  function paintContacts() {
    const box = $("contact-rows");
    box.textContent = "";
    $("contact-none").hidden = state.contacts.length > 0;

    for (const person of state.contacts) {
      const line = document.createElement("div");

      const who = document.createElement("span");
      who.className = "k";
      who.textContent = person.displayName;

      const rest = document.createElement("span");
      // "Manager · Insein", or just the role for somebody who is above every branch.
      rest.textContent = [person.roleLabel, person.where].filter(Boolean).join(" · ");

      // THE NUMBER IS A LINK. This screen exists to be tapped: on the phone in
      // somebody's apron pocket, "call" is the whole feature, and a number you have
      // to read out and retype is a number you get wrong once a week.
      const reach = document.createElement("span");
      reach.className = "sub2";
      if (person.phone) {
        const call = document.createElement("a");
        call.href = `tel:${person.phone.replace(/s+/g, "")}`;
        call.textContent = person.phone;
        reach.append(call);
      } else if (person.email) {
        // No number on their record. The address is worse for a shift that started
        // ten minutes ago, but it beats a row with nothing on it.
        const write = document.createElement("a");
        write.href = `mailto:${person.email}`;
        write.textContent = person.email;
        reach.append(write);
      } else {
        reach.textContent = "No number yet";
      }
      rest.append(reach);

      line.append(who, rest);
      box.append(line);
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
      // null, not omitted: an emptied box means ERASE, and the route reads a present
      // null as exactly that. An empty string would be a second spelling of the same
      // thing, and every reader would have to know both.
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

    // Mirrored from lib/authorization.js, which is where the rule is enforced. This
    // is the courtesy version of it: the route refuses either way, and a person
    // should not have to be refused to find out.
    const own = state.persona !== "operator";
    // §4C: WHO YOU ARE IS NOT YOURS TO EDIT. Your name and your number are how the
    // person above you finds you, calls you and recognises you on a rota, an order
    // and a receipt. The platform owner is the one exception, for the one reason --
    // there is nobody above them to ask.
    const ownsTheirDetails = state.persona === "platform";
    $("a1").disabled = !ownsTheirDetails;
    $("a4").disabled = !ownsTheirDetails;
    // A platform admin has no shop to follow and their own route takes no language at
    // all. Left enabled it accepted a choice, sent nothing, and reverted on return.
    language.disabled = !own || state.persona === "platform";
    say($("a1-note"), ownNote(own, ownsTheirDetails));
  }

  // Who to ask, by name of the job rather than of the person -- a CEO reading "ask
  // your CEO" would be looking for themselves.
  function ownNote(own, ownsTheirDetails) {
    if (!own) return "Leave the company you are working inside to edit your own account.";
    if (ownsTheirDetails) return "Nobody above you to ask, so this one is yours.";
    const asker = {
      company: "the platform owner",
      manager: "your owner",
      staff: "your manager"
    }[state.persona];
    return `Your name and number are how ${asker} finds you. Ask them to change either.`;
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
  // Three things the person block can be doing: appointing the first CEO, replacing
  // the sitting one, or CORRECTING them. The third is §4C's second half -- a CEO
  // cannot fix their own name or number, so the platform owner has to be able to.
  let coFixingCeo = false;

  function openCompanyDialog(company) {
    coEditing = company;
    $("co-h").textContent = company ? "Edit company" : "Add company";
    $("co-save").textContent = company ? "Save" : "Add company";
    $("co-sub").textContent = company
      ? company.name
      : "Every company starts with one CEO.";
    $("co-name").value = company ? company.name : "";
    coSlug.reset(company ? company.slug : "");

    // UNCONDITIONALLY, even when there is no company: a create inherited whatever
    // the last edited company was set to, and the control was visible, because
    // unfinish() un-hides every .group. The create branch sends no status at all, so
    // it was a live-looking control that did nothing -- until the CEO half failed and
    // the dialog turned into an edit, at which point Save suspended a company that was
    // one second old.
    const wanted = company && company.status !== "active" ? "suspended" : "active";
    for (const radio of all('input[name="co-status"]', coDialog)) {
      radio.checked = radio.value === wanted;
    }

    // Two shapes, and which one is showing depends on whether the company already
    // has a CEO. Appointing collects the three person fields; an existing CEO is
    // named, with the two things that can be done to them from out here.
    coReplacing = false;
    coFixingCeo = false;
    unfinish("co-dialog");
    // AFTER unfinish, which puts every block back. Hiding it earlier was undone.
    $("co-status-box").hidden = !company;
    paintCeoBlock();
    $("co-pname").value = "";
    $("co-pemail").value = "";
    $("co-pphone").value = "";
    $("co-pw-field").hidden = true;
    // Same defect, one level up: this one decides whether a replaced CEO keeps an
    // active login to a company they no longer run. It belongs in the open function
    // rather than in paintCeoBlock -- within a single open, somebody who answers and
    // then clicks Replace CEO again should keep their answer.
    $("co-out").hidden = true;
    for (const radio of all('input[name="ceo-out"]', coDialog)) {
      radio.checked = radio.value === "suspend";
    }
    say($("co-slug-warn"), "");
    say($("co-phone-warn"), "");
    say($("co-reset-out"), "");
    openModal(coDialog);
  }

  function paintCeoBlock() {
    const ceo = coEditing && coEditing.ceo;
    const appointing = !coEditing || ceo === null || coReplacing;
    $("co-person").hidden = !(appointing || coFixingCeo);
    $("co-ceo").hidden = !ceo;
    if (ceo) $("co-ceo-who").textContent = `${ceo.displayName} · ${ceo.email}`;
    // Only when a replacement is being appointed, because only then is there an
    // outgoing person for the question to be about.
    $("co-out").hidden = !(ceo && coReplacing);
    if (ceo && coReplacing) $("co-out-who").textContent = ceo.displayName;

    // Correcting somebody is not creating them: the address is their sign-in name and
    // is set once, and no password is minted, so the two controls that belong to a
    // NEW person go away.
    $("co-pemail").disabled = coFixingCeo;
    $("co-pname-l").textContent = coReplacing ? "New CEO name" : "CEO name";
    $("co-pemail-l").textContent = coReplacing ? "New CEO sign-in email" : "CEO sign-in email";
    for (const id of ["co-edit-ceo", "co-reset", "co-replace"]) $(id).hidden = coFixingCeo;
  }

  // §4C's second half. A CEO cannot correct their own name or number -- so a typo in
  // one has to have somewhere to go, and this is it.
  $("co-edit-ceo").addEventListener("click", () => {
    if (!coEditing || !coEditing.ceo) return;
    coFixingCeo = true;
    coReplacing = false;
    $("co-pname").value = coEditing.ceo.displayName;
    $("co-pemail").value = coEditing.ceo.email;
    $("co-pphone").value = coEditing.ceo.phone || "";
    paintCeoBlock();
    $("co-pname").focus();
  });

  // §5.1: read out loud, never mailed. The platform owner is the only person above
  // a CEO, so when a CEO is locked out this button is the whole recovery path.
  $("co-reset").addEventListener("click", async () => {
    if (!coEditing || !coEditing.ceo) return;
    const result = await insideCompany(coEditing.id, () =>
      send(() => api.resetUserPassword(coEditing.ceo.id))
    );
    if (!result || result.state !== "ok") {
      // NOT co-phone-warn: paintCeoBlock hides #co-person exactly when a CEO exists,
      // which is the only state this button is reachable in, so the message went
      // into a hidden box. Success was visible and failure was not -- and this is
      // the only recovery path a locked-out CEO has.
      say($("co-reset-out"), result ? describeFailure(result) : "");
      return;
    }
    say($("co-reset-out"), `New password: ${result.data.initialPassword} — read it out now.`);
  });

  $("co-replace").addEventListener("click", () => {
    coReplacing = true;
    coFixingCeo = false;
    $("co-pname").value = "";
    $("co-pemail").value = "";
    $("co-pphone").value = "";
    paintCeoBlock();
    $("co-pname").focus();
  });

  $("co-cancel").addEventListener("click", () => closeModal(coDialog));

  $("co-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (closedInstead("co-dialog")) return;
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

        // Correcting the sitting CEO is a PATCH, not an appointment. Asked second
        // for the same reason as an appointment: a refusal here must not undo the
        // rename that already worked.
        if (coFixingCeo) {
          const fixed = await fixCeo(coEditing.id, coEditing.ceo.id);
          await refresh("companies");
          if (!fixed) return;
          closeModal(coDialog);
          confirm($("co-done"), "Saved.");
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
            finish("co-dialog", {
              heading: "CEO appointed",
              message: "Read this password out. It is not shown again."
            });
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
        finish("co-dialog", {
          heading: "Company created",
          message: "Read this password out. It is not shown again."
        });
        return;
      }
      // The company IS created either way -- the dialog reopens on it rather than on
      // a blank form, so a second attempt at the CEO is one field away and does not
      // try to create the company again.
      if (ceo.failed) {
        // The 201 body is the same shape the edit branch reads, so it is the right
        // fallback when the list reload also failed: null here left the dialog
        // labelled Edit while still submitting a CREATE.
        coEditing = state.companies.find((c) => c.id === created.data.id) || created.data;
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

  // The name and the number, and nothing else. The address is a sign-in name, and the
  // role is not in question -- this is the platform owner fixing what §4C stops a CEO
  // fixing for themselves.
  async function fixCeo(companyId, ceoUserId) {
    const displayName = $("co-pname").value.trim();
    const phone = $("co-pphone").value.trim();
    if (!displayName || !phone) {
      say($("co-phone-warn"), "A CEO needs a name and a number.");
      return false;
    }
    const result = await insideCompany(companyId, () =>
      send(() => api.updateUser(ceoUserId, { displayName, phone }))
    );
    if (!result || result.state !== "ok") {
      say($("co-phone-warn"), result ? describeFailure(result) : "");
      return false;
    }
    return true;
  }

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

  // ---- a dialog that has finished ----------------------------------------
  //
  // A dialog holding a first password is in a state the mockup never had to draw:
  // the work is DONE, the password will never be shown again, and the form beneath
  // it is describing something that already exists.
  //
  // Leaving it as a form was a real bug and it read as a broken screen. The heading
  // still said "Add company" over a company that had just been added; pressing it
  // again tried to add a second one with the same URL name and got a 409 for its
  // trouble; and the only way out was Cancel, which reads as "undo" -- exactly the
  // wrong word next to a person's account that was just created.
  //
  // So it stops being a form. Its fields go inert, Cancel goes away because there is
  // nothing left to cancel, and the one remaining button says Done and closes.
  const FINISHED = Object.freeze({
    "co-dialog": { heading: "co-h", sub: "co-sub", cancel: "co-cancel", submit: "co-save", password: "co-pw-field" },
    "staff-dialog": { heading: "staff-h", sub: "staff-sub", cancel: "staff-cancel", submit: "staff-save", password: "st-temp-field" }
  });

  // Every block a dialog is built from. Hiding by shape rather than by id, so a field
  // added to the markup later cannot be the one that stays behind.
  const BLOCKS = ".field, .group, .choice, .limit, .facts";

  function finish(dialogId, { heading, message }) {
    const parts = FINISHED[dialogId];
    const dialog = $(dialogId);
    const password = $(parts.password);
    dialog.dataset.finished = "true";
    $(parts.heading).textContent = heading;
    $(parts.sub).textContent = message;
    $(parts.cancel).hidden = true;
    $(parts.submit).textContent = "Done";

    // EVERYTHING THE PERSON IS NO LONGER EDITING GOES AWAY. Leaving eight inert
    // fields above the one line that matters is what pushed the password and the way
    // out below the fold -- the dialog scrolled, and the only visible thing was a
    // form describing a company that already existed.
    for (const block of all(BLOCKS, dialog)) {
      if (block === password || block.contains(password)) continue;
      block.hidden = true;
    }
    // readonly is left alone: a disabled input cannot be selected, and a password
    // that cannot be selected cannot be copied. The whole point of the field is that
    // somebody reads it off the screen.
    for (const field of all("input, select, textarea", dialog)) {
      if (!field.readOnly) field.disabled = true;
    }
    // Every other control does something to a record the person has finished with.
    // Reset password on a brand-new account is the clearest one: it would throw away
    // the password still on screen beside it.
    for (const button of all("button.ghost", dialog)) button.hidden = true;
    $(parts.submit).focus();
  }

  // Called by both open functions, because a dialog is reused and the state above
  // would otherwise persist into the next thing it is opened for. It puts everything
  // BACK; the open function then hides what that particular record does not need.
  function unfinish(dialogId) {
    const parts = FINISHED[dialogId];
    const dialog = $(dialogId);
    delete dialog.dataset.finished;
    $(parts.cancel).hidden = false;
    for (const block of all(BLOCKS, dialog)) block.hidden = false;
    for (const field of all("input, select, textarea", dialog)) {
      if (!field.readOnly) field.disabled = false;
    }
    for (const button of all("button.ghost", dialog)) button.hidden = false;
  }

  // True when the button that used to submit now only closes. Checked at the top of
  // both submit handlers, so the finished state cannot be re-submitted by Enter
  // either -- a keyboard is how the duplicate would have been created.
  function closedInstead(dialogId) {
    if ($(dialogId).dataset.finished !== "true") return false;
    closeModal($(dialogId));
    return true;
  }

  // ---- the shop dialog ----------------------------------------------------

  const shopDialog = $("shop-dialog");

  // Which company the open branch belongs to. For a CEO or an operator that is the
  // one they are standing in; for the platform owner it is whichever row they opened
  // the branch from, and there is no session answer to fall back on.
  function shopDialogCompany() {
    const id = shopDialog.dataset.companyId;
    if (state.me.company && state.me.company.id === id) return state.me.company;
    return state.companies.find((company) => company.id === id) || null;
  }
  const shSlug = wireSlug($("sh-name"), $("sh-slug"), $("sh-slug-url"), $("sh-slug-warn"), () => {
    // The company the BRANCH belongs to, not the one the session is in. A platform
    // owner opening a branch from a company row is in no company at all, and the
    // preview would have read "app/company/bogyoke".
    const company = shopDialogCompany();
    return `app/${company ? company.slug : "company"}/`;
  });
  let shEditing = null;

  function openShopDialog(shop, { companyId } = {}) {
    shEditing = shop;
    const opening = shop === null;
    const owner = state.persona === "operator" || state.persona === "platform";

    $("shop-h").textContent = opening ? "Open a branch" : "Edit shop";
    $("shop-sub").textContent = opening ? "" : shop.name;
    $("shop-save").textContent = opening ? "Open branch" : "Save";

    // BEFORE shSlug.reset, which paints the preview synchronously off this value.
    // Assigned eighty lines later, the first branch dialog of a session read
    // "app/company/bogyoke" -- the exact string the preview exists to prevent -- and
    // every one after it wore the previously opened company's name.
    shopDialog.dataset.companyId = companyId || state.me.scope.companyId || "";

    $("sh-name").value = opening ? "" : shop.name;
    shSlug.reset(opening ? "" : shop.slug);
    $("sh-addr").value = opening ? "" : shop.address || "";

    // §8A: what the branch IS -- its name, its address, its URL -- belongs to the
    // platform owner, because a rename reaches inside the company.
    //
    // HIDDEN from a CEO, not greyed out. A disabled box is still a box they have to
    // read past, and one of them is labelled "URL name" -- a phrase about web
    // addresses shown to somebody running a restaurant. What the branch is called and
    // where it is are FACTS to them, and the facts panel above already says so.
    for (const id of ["sh-name-field", "sh-slug-field", "sh-addr-field"]) {
      $(id).hidden = !owner;
    }

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
    // Shown to the owner on an EDIT too. Set once when the branch opens is the rule
    // for who may change them, not a rule that they can never be wrong: a branch
    // opened with the wrong currency prints the wrong money on every receipt, and no
    // persona anywhere could repair it. The CEO and the manager still only read them.
    $("sh-country").hidden = !opening && !owner;
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
        ["Address", shop.address || ""],
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

    // THE ANSWER IS ABOUT ONE PERSON, and it decides whether they keep their login.
    // Hiding the group left the previous shop's choice checked, so a CEO who once
    // said "they have left" suspended the next departing manager without being asked
    // -- and one "keep them" quietly kept every later one active.
    $("handover").hidden = true;
    for (const radio of all('input[name="handover"]', shopDialog)) {
      radio.checked = radio.value === "staff";
    }
    say($("sh-name-warn"), "");
    say($("sh-country-warn"), "");
    say($("sh-slug-warn"), "");
    say($("sh-mgr-warn"), "");
    openModal(shopDialog);
  }

  // §3.0: a manager may hold two shops, so the list is everyone who could run one --
  // not everyone who is free.
  function paintManagerChoices(shop) {
    const current = managerOf(shop);
    const candidates = state.users.filter(
      (user) =>
        (user.role === "shop_manager" || user.role === "staff") &&
        // A suspended account cannot sign in, so appointing one leaves the shop with
        // nobody -- and the server refuses it with the reason landing under a field
        // the CEO cannot even type into. The SITTING manager is never dropped: if
        // they were, the select would fall back to "" and a Save would clear the slot.
        (user.status === "active" || (current && user.id === current.id))
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
    const address = $("sh-addr").value.trim();
    if (address) input.address = address;

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
    await reopenBranches(companyId);
  }

  async function saveBranch() {
    const owner = state.persona === "operator" || state.persona === "platform";
    if (owner) {
      const problem = shSlug.problem();
      if (problem) {
        say($("sh-slug-warn"), problem);
        return;
      }
      if (!$("sh-tz").value || !$("sh-cur").value || !$("sh-lang").value) {
        say($("sh-country-warn"), "A branch needs all three.");
        return;
      }
      const changes = {
        name: $("sh-name").value.trim(),
        slug: $("sh-slug").value.trim(),
        timeZone: $("sh-tz").value,
        currency: $("sh-cur").value,
        language: $("sh-lang").value
      };
      // Omitted rather than sent as null when blank. The route validates a present
      // key, and `address: null` is refused as the wrong TYPE -- so a branch with no
      // address could not be opened, and one that had none could not be saved.
      const address = $("sh-addr").value.trim();
      if (address) changes.address = address;
      // Same split as opening one: an operator already stands in the company, and a
      // platform owner reaches into it for this one write and comes back.
      const write = () => send(() => api.updateShop(shEditing.id, changes));
      const result =
        state.persona === "operator"
          ? await write()
          : await insideCompany(shopDialog.dataset.companyId, write);
      if (!result) return;
      if (result.state !== "ok") {
        say($("sh-slug-warn"), describeFailure(result));
        return;
      }
      closeModal(shopDialog);
      confirm($(state.screen === "companies" ? "co-done" : "shop-done"), "Saved.");
      const reopen = shopDialog.dataset.companyId;
      await refresh(state.screen);
      await reopenBranches(reopen);
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
      say($("sh-mgr-warn"), describeFailure(result));
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
        const day = await send(() => api.updateShopDayToDay(shEditing.id, changes));
        // The manager slot already landed; this half can still be refused, and the
        // dialog used to close and say "Saved." over a receipt footer that was thrown
        // away by the refresh behind it.
        if (!day) return;
        if (day.state !== "ok") {
          say($("sh-slug-warn"), describeFailure(day));
          return;
        }
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
    unfinish("staff-dialog");
    const adding = user === null;
    const asManager = state.persona === "manager";

    $("staff-h").textContent = adding ? "Add staff" : user.displayName;
    $("staff-save").textContent = adding ? "Add" : "Save";
    $("staff-sub").textContent = asManager ? (activeShop() || {}).name || "" : "";

    $("st-name").value = adding ? "" : user.displayName;
    $("st-email").value = adding ? "" : user.email;
    // §6.2: an email is a sign-in name. Changing it is how somebody quietly takes
    // over an account, so it is set once, at the point the account is created.
    $("st-email").disabled = !adding;
    $("st-phone").value = adding ? "" : user.phone || "";

    // WHICH RECORD, not which viewer. Keyed on the persona alone, this offered a
    // single-value picker for a manager who runs two shops -- and Save sent the one
    // it happened to be showing, so the OTHER shop silently lost its manager and read
    // "No manager yet". §3.0 forbids exactly this control by name: a manager's shops
    // are the slots that name them, set one shop at a time on the Shops screen.
    //
    // A company_admin has none at all, and sending them any is a 422 with no control
    // on the dialog able to clear it -- their row could never be saved.
    const shopField = $("st-shop-field");
    const offerShop = !asManager && (adding || user.role === "staff");
    shopField.hidden = !offerShop;
    if (offerShop) {
      fillSelect($("st-shop"), state.shops.map((shop) => [shop.id, shop.name]));
      const held = (user && user.shopIds) || [];
      if (held.length > 0) $("st-shop").value = held[0];
    }

    // A company with no branches yet can still hire. The picker has nothing to show,
    // so it is not shown -- and the limit line below says the placing comes later
    // rather than leaving an empty control to be puzzled over.
    const noBranches = offerShop && state.shops.length === 0;
    if (noBranches) shopField.hidden = true;

    $("st-temp-field").hidden = true;
    // say() sets hidden = !text, so nothing ever put this back. A refused "Add staff"
    // left its red line under the phone number of every person opened afterwards.
    say($("st-phone-warn"), "");
    // The reset handler rewrites this line, and a dialog is reused. Without putting
    // it back, every person opened afterwards is told to read out a password that is
    // not on the screen.
    $("st-reset-hint").textContent =
      "For when they have forgotten it. You will get a new one to read out.";
    $("st-access").hidden = adding;
    if (!adding) {
      for (const radio of all('input[name="access"]', staffDialog)) {
        radio.checked = radio.value === (user.status === "active" ? "active" : "suspended");
      }
    }
    $("st-reset").hidden = adding;
    $("st-limit").textContent = asManager
      ? "Only your CEO can make someone a manager or move them to another shop."
      : noBranches
        ? "No branches yet, so this person is not placed at one. Move them into a branch as soon as there is one."
        : !adding && user.role === "shop_manager"
          ? "Which shops this manager runs is set on the Shops screen, one at a time. They can run more than one."
          : !adding && user.role === "company_admin"
            ? "The owner is company-wide and belongs to no single branch."
            : "Anyone you add here signs in with the password you read out to them.";
    openModal(staffDialog);
  }

  $("staff-cancel").addEventListener("click", () => closeModal(staffDialog));

  $("staff-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (closedInstead("staff-dialog")) return;
    const button = $("staff-save");
    button.disabled = true;
    try {
      const asManager = state.persona === "manager";
      if (stEditing === null) {
        const shop = asManager ? activeShop() : { id: $("st-shop").value };
        const input = {
          email: $("st-email").value.trim(),
          displayName: $("st-name").value.trim(),
          phone: $("st-phone").value.trim(),
          role: "staff"
        };
        // Absent, not empty, when there is nowhere to put them. The route reads both
        // the same way; sending the key only when a branch was actually chosen keeps
        // the body honest about what the person on the screen decided.
        if (shop && shop.id) input.shopIds = [shop.id];
        const result = await send(() => api.createUser(input));
        if (!result) return;
        if (result.state !== "ok") {
          say($("st-phone-warn"), describeFailure(result));
          return;
        }
        showFirstPassword($("st-temp"), $("st-temp-field"), result.data.initialPassword);
        finish("staff-dialog", {
          heading: "Staff added",
          message: "Read this password out. It is not shown again."
        });
        await refresh("users");
        return;
      }

      const status = (all('input[name="access"]', staffDialog).find((r) => r.checked) || {}).value;
      const changes = {
        displayName: $("st-name").value.trim(),
        phone: $("st-phone").value.trim(),
        status
      };
      // ONLY when the dialog actually offered it. Sending a shop the person never
      // saw is how a two-shop manager lost one of them, and how a company owner got a
      // 422 they had no way to clear -- and when there are no branches at all, the key
      // is absent, which the route reads as "not placed yet".
      if (!$("st-shop-field").hidden) changes.shopIds = [$("st-shop").value];
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
    if (!result) return;
    if (result.state !== "ok") {
      // The button looked dead: no password, no error, and the hint still promising
      // one. Somebody was on the phone waiting for it.
      $("st-reset-hint").textContent = describeFailure(result);
      return;
    }
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
      // A <dialog> opened with showModal() sits in the top layer, which is OUTSIDE
      // #signedIn -- hiding the console leaves it on screen, modal, over a sign-in
      // card the person cannot type into.
      for (const dialog of all("dialog[open]")) dialog.close();
      $("signedIn").hidden = true;
      delete document.body.dataset.as;
    }
  };
}
