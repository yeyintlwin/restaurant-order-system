"use strict";

// Everything the console decides that is not a DOM operation and not a request.
//
// It exists so the decisions can be tested. "Which screens does this person get" and
// "is this URL name legal" are the two places where being wrong is expensive -- one
// shows somebody a screen that is not theirs, the other sends a request that was
// always going to be refused -- and neither needs a browser to be checked.
//
// Loaded by the browser as an ES module and by node --test as CommonJS, the same way
// api.js is.

// ---------------------------------------------------------------------------
// Who is looking
// ---------------------------------------------------------------------------

// FIVE personas, not the four roles. A platform admin who has selected a company is
// doing something a platform admin at rest is not: they are inside one tenant, and
// every company-shaped screen applies to them. The console draws by persona, so the
// distinction has to exist before any markup does.
//
// The scope, not the role, is what separates the first two -- which is why this reads
// the scope. A platform admin who has NOT selected a company has no company_id
// anywhere in their session, and every tenant-scoped route would refuse them.
function personaOf(me) {
  if (!me || !me.user) return null;
  const role = me.user.role;
  if (role === "platform_admin") {
    const selected = me.scope && me.scope.companyId;
    return selected ? "operator" : "platform";
  }
  if (role === "company_admin") return "company";
  if (role === "shop_manager") return "manager";
  if (role === "staff") return "staff";
  // An unknown role is not a reason to guess. Showing nothing is recoverable;
  // showing the platform owner's screens to somebody the client does not recognise
  // is not.
  return null;
}

// What the person is called in their own console. The platform owner and the
// operator are the same account and deliberately read differently: the second line
// of the rail already says which company, and "Platform owner" beside a company name
// reads as a mistake.
const ROLE_LABEL = Object.freeze({
  platform: "Platform owner",
  operator: "Platform owner",
  company: "Owner",
  manager: "Manager",
  staff: "Staff"
});

function roleLabel(persona) {
  return ROLE_LABEL[persona] || "";
}

// The screens a persona may reach, in menu order. The markup carries the same
// information in data-for, and the CSS hides on it; this is the copy the JavaScript
// navigates by, so a link that is hidden can also never be the current view.
const SCREENS = Object.freeze({
  platform: ["dashboard", "companies", "settings", "account"],
  operator: ["dashboard", "shops", "users", "settings", "account"],
  company: ["dashboard", "shops", "users", "settings", "account"],
  manager: ["dashboard", "users", "settings", "account"],
  staff: ["dashboard", "account"]
});

function screensFor(persona) {
  return SCREENS[persona] || [];
}

// A screen reached by someone it does not belong to falls back to the one screen
// everybody has. Deep links and a persona change under a stale hash both land here.
function resolveScreen(persona, wanted) {
  const allowed = screensFor(persona);
  if (allowed.length === 0) return null;
  return allowed.includes(wanted) ? wanted : allowed[0];
}

// ---------------------------------------------------------------------------
// URL names
// ---------------------------------------------------------------------------

// The DDL's spelling, character for character. THREE copies of this rule exist -- the
// CHECK constraint, core-api's validator, and this one -- and they are only correct
// while they are identical. It forbids four things at once: a leading digit, a
// trailing hyphen, two hyphens in a row, and anything outside [a-z0-9-].
const SLUG_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SLUG_MIN = 2;
const SLUG_MAX = 24;

// A suggestion, never a repair. The field is filled from the display name until the
// person touches it, and from then on it is theirs -- a slug that keeps rewriting
// itself under the cursor is worse than an empty one.
function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    // NFKD splits "é" into "e" plus a combining accent; dropping the accents is what
    // turns "Shwe Café" into "shwe-cafe" rather than "shwe-caf".
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[0-9]+/, "")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

// The wording the field shows. Returns "" for a legal name so the caller can treat
// the result as the message and the verdict at once.
function slugProblem(value) {
  const v = String(value == null ? "" : value);
  if (v === "") return "A URL name is required.";
  if (v.length < SLUG_MIN) return `At least ${SLUG_MIN} characters.`;
  if (v.length > SLUG_MAX) return `At most ${SLUG_MAX} characters.`;
  if (!SLUG_PATTERN.test(v)) {
    return "Lowercase letters, numbers and single hyphens. It has to start with a letter.";
  }
  return "";
}

// ---------------------------------------------------------------------------
// What went wrong
// ---------------------------------------------------------------------------

// The server's wording, always. 5.8(b) keeps "wrong password" and "unknown email"
// indistinguishable, and a client that writes its own text is how those two drift
// apart. Field codes get a short gloss because "too_short" is not a sentence, and
// the gloss is the only text here this file invents.
const FIELD_TEXT = Object.freeze({
  required: "is required",
  too_short: "is too short",
  too_long: "is too long",
  pattern: "is not in the right shape",
  type: "is not the right kind of value",
  not_in_enum: "is not one of the accepted values",
  invalid_uuid: "is not valid",
  immutable: "cannot be changed",
  out_of_range: "is out of range",
  empty: "cannot be empty"
});

// Field names as the person reading them would say them.
const FIELD_LABEL = Object.freeze({
  slug: "URL name",
  displayName: "Name",
  tableCount: "Tables",
  timeZone: "Time zone",
  businessDayRolloverHour: "Business day start",
  openingHours: "Opening hours",
  receiptFooter: "Receipt footer",
  managerUserId: "Manager",
  runByOwner: "Who runs it",
  shopIds: "Shops",
  newPassword: "New password",
  currentPassword: "Current password"
});

function fieldLabel(field) {
  if (FIELD_LABEL[field]) return FIELD_LABEL[field];
  // camelCase to words, then sentence case: "receiptFooter" reads as "Receipt footer"
  // without a table entry for every field that needs no special wording.
  const spaced = String(field).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function describeFailure(result) {
  if (!result) return "Something went wrong.";
  if (result.state === "unreachable") {
    return "Could not reach the server. Check your connection and try again.";
  }
  if (result.fieldErrors && result.fieldErrors.length > 0) {
    return result.fieldErrors
      .map((entry) => `${fieldLabel(entry.field)} ${FIELD_TEXT[entry.code] || "is not accepted"}`)
      .join("; ");
  }
  return result.message || "Something went wrong.";
}

// ---------------------------------------------------------------------------
// Small things every screen draws
// ---------------------------------------------------------------------------

// Two letters from two words, or the first two of one. Never from the email: an
// avatar reading "YE" beside the name "Ye Yint Lwin" is right, and one reading "YE"
// beside "yeyintlwin@..." is a coincidence.
function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// §3.1A: a shop has three states, not two, and "nobody yet" and "the owner runs it"
// are different answers. A cell that shows a dash for both is the bug this replaces.
function managerState(shop, manager) {
  if (manager) return { kind: "person", label: manager.displayName, detail: manager.email };
  if (shop && shop.runByOwner) return { kind: "owner", label: "Run by the owner", detail: "" };
  return { kind: "gap", label: "No manager yet", detail: "" };
}

// Loaded as an ES module in the browser and required by node --test, the same two
// lines api.js uses. The guard matters: node sees the `export` below and treats the
// file as ESM, where `module` does not exist at all.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    personaOf,
    roleLabel,
    screensFor,
    resolveScreen,
    slugify,
    slugProblem,
    describeFailure,
    fieldLabel,
    initials,
    managerState,
    SLUG_MIN,
    SLUG_MAX
  };
}
export {
  personaOf,
  roleLabel,
  screensFor,
  resolveScreen,
  slugify,
  slugProblem,
  describeFailure,
  fieldLabel,
  initials,
  managerState,
  SLUG_MIN,
  SLUG_MAX
};
