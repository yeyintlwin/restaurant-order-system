// The shell: the four states that exist before the console does, and the handover to
// it. Every call to core-api goes through api.js, which is the file with the tests --
// this one must not grow a fetch of its own.
import { createApi } from "/api.js";
import { describeFailure } from "/shape.js";
import { mountConsole } from "/console.js";

const api = createApi(fetch);
const $ = (id) => document.getElementById(id);

const STATES = ["loading", "signedOut", "mustChange"];

// The console is not one of the card's states. It is a different shape -- full
// height, its own rail -- so the card is put away rather than switched.
function show(state) {
  const card = $("card");
  card.hidden = state === null;
  for (const name of STATES) $(name).hidden = name !== state;
}

function setError(element, text) {
  element.textContent = text;
  element.hidden = !text;
}

let console_ = null;

function toSignedOut() {
  // A CONSOLE THAT WAS MOUNTED IS TORN DOWN BY RELOADING. mountConsole binds
  // listeners to nodes that outlive it -- the rail, the dialogs, the document --
  // and nothing detached them, so signing in again in the same tab ran every
  // handler twice: one press of Add issued two creates, the second failing 409
  // beside a first password that may not be the one the server kept.
  //
  // The guard is load-bearing. apply() sends the FIRST /me here too when nobody is
  // signed in, and reloading then would be an endless refresh.
  if (console_) {
    console_.unmount();
    console_ = null;
    location.reload();
    return;
  }
  $("email").value = "";
  $("password").value = "";
  show("signedOut");
}

function toConsole(me) {
  show(null);
  // Mounted once per session. Re-mounting on every /me would attach a second copy of
  // every listener, and the second copy is the one that fires twice.
  if (console_) return;
  console_ = mountConsole({ api, me, onSignedOut: toSignedOut });
}

function apply(result) {
  if (result.state === "signedIn") {
    toConsole(result.me);
    return;
  }
  if (result.state === "mustChangePassword") {
    show("mustChange");
    return;
  }
  if (result.state === "unreachable" || result.state === "failed") {
    show("signedOut");
    setError($("signInError"), describeFailure(result));
    return;
  }
  toSignedOut();
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
      setError($("signInError"), describeFailure(result));
      return;
    }
    apply(result);
  });
});

function changeHandler({ currentId, newId, confirmId, errorId, buttonId }) {
  return (event) => {
    event.preventDefault();
    return submitting($(buttonId), async () => {
      setError($(errorId), "");

      // CHECKED HERE, because the server never sees the confirmation field. It is
      // the only place a typo can be caught, and on this form it is the difference
      // between a second attempt and a locked-out account: the password that got
      // them here is spent the moment this succeeds.
      if ($(newId).value !== $(confirmId).value) {
        setError($(errorId), "The two new passwords do not match.");
        return;
      }

      const result = await api.changePassword($(currentId).value, $(newId).value);
      if (result.state !== "signedIn") {
        setError($(errorId), describeFailure(result));
        return;
      }
      for (const id of [currentId, newId, confirmId]) $(id).value = "";
      apply(result);
    });
  };
}

// The card's forced form -- the screen somebody lands on the first time they ever
// sign in, holding a password that was read out to them. The console has its own in
// Account settings, and it asks twice for the same reason.
$("forcedForm").addEventListener(
  "submit",
  changeHandler({
    currentId: "forcedCurrent",
    newId: "forcedNew",
    confirmId: "forcedConfirm",
    errorId: "forcedError",
    buttonId: "forcedButton"
  })
);

const pwDialog = $("pw-dialog");
const pwFields = ["currentPassword", "newPassword", "confirmPassword"];

$("pw-open").addEventListener("click", () => {
  for (const id of pwFields) $(id).value = "";
  setError($("pw-warn"), "");
  setError($("pw-done"), "");
  pwDialog.showModal();
});
$("pw-cancel").addEventListener("click", () => pwDialog.close());

$("pw-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const submit = event.submitter || $("pw-form").querySelector('button[type="submit"]');
  return submitting(submit, async () => {
    // Checked here rather than by the server, because the server never sees the
    // confirmation field. A mistyped new password that nobody typed twice is a
    // lockout, and this is the only place it can be caught.
    if ($("newPassword").value !== $("confirmPassword").value) {
      setError($("pw-warn"), "The two new passwords do not match.");
      return;
    }
    setError($("pw-warn"), "");
    const result = await api.changePassword($("currentPassword").value, $("newPassword").value);
    if (result.state !== "signedIn") {
      setError($("pw-warn"), describeFailure(result));
      return;
    }
    for (const id of pwFields) $(id).value = "";
    pwDialog.close();
    // 4.3 again: this is why "you have been signed out on your phone" is not a
    // surprise. The line stays on the screen behind the dialog rather than inside
    // the dialog that just closed.
    setError($("pw-done"), "Password changed. Your other devices have been signed out.");
  });
});

apply(await api.me());
