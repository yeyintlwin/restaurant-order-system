"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
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
} = require("../public/shape.js");

// --- who is looking ---------------------------------------------------------

test("a platform admin is two different people depending on their scope", () => {
  // THE distinction the mockup could not draw. A platform admin at rest is above
  // every company; one who has selected a company is inside exactly one, and every
  // tenant-scoped route now applies to them. Drawing them the same way is how the
  // Companies list ends up on a screen where it cannot load.
  const unscoped = { user: { role: "platform_admin" }, scope: { kind: "platform", companyId: null } };
  const scoped = { user: { role: "platform_admin" }, scope: { kind: "tenant", companyId: "c1" } };
  assert.equal(personaOf(unscoped), "platform");
  assert.equal(personaOf(scoped), "operator");
});

test("every other role maps to itself, and an unknown one to nobody", () => {
  const as = (role) => personaOf({ user: { role }, scope: { companyId: "c1" } });
  assert.equal(as("company_admin"), "company");
  assert.equal(as("shop_manager"), "manager");
  assert.equal(as("staff"), "staff");
  // Not a guess, and not the most powerful persona. Showing nothing is recoverable;
  // showing the platform owner's screens to somebody the client does not recognise
  // is not.
  assert.equal(as("superuser"), null);
  assert.equal(personaOf(null), null);
  assert.equal(personaOf({}), null);
});

test("the operator is still called Platform owner", () => {
  // The second line of the rail already says which company. "Owner" beside a
  // company name would read as the CEO, who is a different person.
  assert.equal(roleLabel("operator"), "Platform owner");
  assert.equal(roleLabel("platform"), "Platform owner");
  assert.equal(roleLabel("company"), "Owner");
  assert.equal(roleLabel("manager"), "Manager");
});

test("each persona reaches its own screens and no others", () => {
  // The platform owner has no Users screen at all. §2: they build the PLACES and
  // appoint only the CEO -- there is deliberately nothing here that lists a manager
  // or a member of staff.
  assert.deepEqual(screensFor("platform"), ["dashboard", "companies", "settings", "account"]);
  assert.ok(!screensFor("platform").includes("users"));
  assert.ok(!screensFor("platform").includes("shops"));

  // A CEO has no Companies screen: there is one company and they are in it.
  assert.ok(!screensFor("company").includes("companies"));
  // Staff have the two screens that are about them and nothing else.
  assert.deepEqual(screensFor("staff"), ["dashboard", "account"]);
});

test("a screen somebody cannot reach falls back rather than throwing", () => {
  // A stale hash and a persona change under an open screen both land here. Dashboard
  // is the one screen everybody has.
  assert.equal(resolveScreen("manager", "companies"), "dashboard");
  assert.equal(resolveScreen("staff", "settings"), "dashboard");
  assert.equal(resolveScreen("company", "shops"), "shops");
  // Nobody at all reaches nothing at all, and the caller checks for null rather
  // than being handed a screen.
  assert.equal(resolveScreen(null, "dashboard"), null);
});

// --- URL names --------------------------------------------------------------

test("slugify suggests something legal from anything typed", () => {
  assert.equal(slugify("Bogyoke"), "bogyoke");
  assert.equal(slugify("Mandalay Grill"), "mandalay-grill");
  // NFKD plus dropping the marks: the accent goes and the letter under it stays.
  assert.equal(slugify("Shwe Café"), "shwe-cafe");
  assert.equal(slugify("  --Odd  Name-- "), "odd-name");
  // A leading digit is illegal, so it is dropped rather than kept and refused.
  assert.equal(slugify("7-Eleven Shop"), "eleven-shop");
  // Nothing usable in, nothing out -- and "" is a state the field already draws.
  assert.equal(slugify("日本"), "");
  assert.equal(slugify(""), "");
  assert.equal(slugify(null), "");
});

test("whatever slugify suggests, slugProblem accepts", () => {
  // The two halves have to agree or the form fills itself in with something it then
  // refuses to submit.
  for (const name of ["Bogyoke", "Mandalay Grill", "Shwe Café", "7-Eleven Shop", "A B C D E F G H I J K L"]) {
    const slug = slugify(name);
    if (slug.length >= SLUG_MIN) assert.equal(slugProblem(slug), "", `${name} -> ${slug}`);
  }
});

test("slugProblem forbids the four shapes the constraint forbids", () => {
  // The DDL's pattern rules out a leading digit, a trailing hyphen, two hyphens in a
  // row, and anything outside [a-z0-9-]. All four, said in words a person can act on.
  assert.notEqual(slugProblem("1shop"), "");
  assert.notEqual(slugProblem("shop-"), "");
  assert.notEqual(slugProblem("sh--op"), "");
  assert.notEqual(slugProblem("Shop"), "");
  assert.notEqual(slugProblem("my shop"), "");
  assert.notEqual(slugProblem("-shop"), "");

  assert.notEqual(slugProblem(""), "");
  assert.notEqual(slugProblem("a"), "");
  assert.notEqual(slugProblem("a".repeat(SLUG_MAX + 1)), "");
  assert.equal(slugProblem("a".repeat(SLUG_MAX)), "");
  assert.equal(slugProblem("ab"), "");
  assert.equal(slugProblem("a1-b2-c3"), "");
});

// --- what went wrong --------------------------------------------------------

test("a field error is said in the words of the field, not the API", () => {
  assert.equal(
    describeFailure({ state: "failed", fieldErrors: [{ field: "slug", code: "too_long" }] }),
    "URL name is too long"
  );
  // Every failure at once, because the route reports them at once and fixing one
  // per round trip is the experience that produces.
  assert.equal(
    describeFailure({
      state: "failed",
      fieldErrors: [
        { field: "displayName", code: "required" },
        { field: "email", code: "required" }
      ]
    }),
    "Name is required; Email is required"
  );
});

test("a field with no entry in the table is still readable", () => {
  // camelCase becomes words, so adding a field to a route does not mean adding a
  // line here before it can be reported.
  assert.equal(fieldLabel("receiptFooter"), "Receipt footer");
  assert.equal(fieldLabel("businessDayRolloverHour"), "Business day start");
});

test("an unreachable server is never reported as a credential problem", () => {
  // 5.8(b) keeps "wrong password" and "unknown email" indistinguishable. A network
  // failure is neither, and saying so is the difference between "try again" and
  // "check your password".
  const text = describeFailure({ state: "unreachable" });
  assert.match(text, /Could not reach the server/);
  assert.doesNotMatch(text, /password/i);
});

test("without a field list, the server's own sentence is used verbatim", () => {
  assert.equal(
    describeFailure({ state: "failed", code: "email_unavailable", message: "That email is taken." }),
    "That email is taken."
  );
  assert.equal(describeFailure(null), "Something went wrong.");
});

// --- small things -----------------------------------------------------------

test("initials come from the name and never from the address", () => {
  // "YE" beside "Ye Yint Lwin" is right; "YE" beside "yeyintlwin@..." is a
  // coincidence, and the day the address changes it becomes wrong.
  assert.equal(initials("Ye Yint Lwin"), "YL");
  assert.equal(initials("Khin Myat"), "KM");
  assert.equal(initials("Sakura"), "SA");
  assert.equal(initials("  "), "?");
  assert.equal(initials(null), "?");
});

test("a shop has THREE manager states, and two of them are not a person", () => {
  const shop = { runByOwner: false };
  // §3.1A: "nobody yet" and "the owner runs it" are different answers, and a cell
  // that shows a dash for both is the bug this replaces.
  assert.deepEqual(managerState(shop, null), { kind: "gap", label: "No manager yet", detail: "" });
  assert.deepEqual(managerState({ runByOwner: true }, null), {
    kind: "owner",
    label: "Run by the owner",
    detail: ""
  });
  assert.deepEqual(managerState(shop, { displayName: "Thura Zaw", email: "t@e.test" }), {
    kind: "person",
    label: "Thura Zaw",
    detail: "t@e.test"
  });
  // A person present beats the flag: whatever the column says, somebody is in the
  // slot, and showing "Run by the owner" over their name would be a lie about who
  // to call.
  assert.equal(managerState({ runByOwner: true }, { displayName: "T", email: "e" }).kind, "person");
});
