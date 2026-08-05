// DOM wiring only. Every call to core-api goes through api.js, which is the file
// with the tests -- this one must not grow a fetch of its own.
import { createApi } from "/api.js";

const api = createApi(fetch);
const $ = (id) => document.getElementById(id);

const STATES = ["loading", "signedOut", "signedIn", "mustChange"];

function show(state) {
  for (const name of STATES) $(name).hidden = name !== state;
}

function setError(element, text) {
  element.textContent = text;
  element.hidden = !text;
}

// The server's wording, always. 5.8(b) keeps "wrong password" and "unknown email"
// indistinguishable, and a client that writes its own text is how they drift apart.
// Field codes get a short gloss because "too_short" is not a sentence.
const FIELD_TEXT = Object.freeze({
  required: "is required",
  too_short: "must be at least 12 characters",
  too_long: "is too long",
  invalid_uuid: "is not valid"
});

function describe(result) {
  if (result.state === "unreachable") {
    return "Could not reach the server. Check your connection and try again.";
  }
  if (result.fieldErrors && result.fieldErrors.length > 0) {
    return result.fieldErrors
      .map((entry) => `${entry.field} ${FIELD_TEXT[entry.code] || "is not accepted"}`)
      .join("; ");
  }
  return result.message;
}

function renderSignedIn(me) {
  $("identityEmail").textContent = me.user.email;
  const company = me.scope.companyId ? `company ${me.scope.companyId}` : "no company selected";
  $("identityRole").textContent = `${me.user.role} · ${company}`;
  show("signedIn");
}

function apply(result) {
  if (result.state === "signedIn") {
    renderSignedIn(result.me);
    return;
  }
  if (result.state === "mustChangePassword") {
    show("mustChange");
    return;
  }
  show("signedOut");
}

async function submitting(button, run) {
  button.disabled = true;
  try {
    await run();
  } finally {
    button.disabled = false;
  }
}

$("signInForm").addEventListener("submit", (event) => {
  event.preventDefault();
  return submitting($("signInButton"), async () => {
    setError($("signInError"), "");
    const result = await api.login($("email").value.trim(), $("password").value);
    if (result.state === "failed" || result.state === "unreachable") {
      // KEEP THE EMAIL, CLEAR THE PASSWORD. A page that clears itself on a wrong
      // password makes a typo cost the whole entry.
      $("password").value = "";
      setError($("signInError"), describe(result));
      return;
    }
    apply(result);
  });
});

function changeHandler(currentId, newId, errorId, buttonId, okId) {
  return (event) => {
    event.preventDefault();
    return submitting($(buttonId), async () => {
      setError($(errorId), "");
      if (okId) setError($(okId), "");
      const result = await api.changePassword($(currentId).value, $(newId).value);
      if (result.state !== "signedIn") {
        setError($(errorId), describe(result));
        return;
      }
      $(currentId).value = "";
      $(newId).value = "";
      // Spec 4.3: a success mints a fresh session and kills every other one. Saying
      // so here is why "you have been signed out on your phone" is not a surprise.
      if (okId) setError($(okId), "Password updated. Every other session was signed out.");
      renderSignedIn(result.me);
    });
  };
}

$("changeForm").addEventListener("submit", changeHandler("currentPassword", "newPassword", "changeError", "changeButton", "changeOk"));
$("forcedForm").addEventListener("submit", changeHandler("forcedCurrent", "forcedNew", "forcedError", "forcedButton", null));

for (const [id, everywhere] of [["signOut", false], ["signOutAll", true]]) {
  $(id).addEventListener("click", () =>
    submitting($(id), async () => {
      await api.logout(everywhere);
      $("email").value = "";
      $("password").value = "";
      show("signedOut");
    })
  );
}

apply(await api.me());
