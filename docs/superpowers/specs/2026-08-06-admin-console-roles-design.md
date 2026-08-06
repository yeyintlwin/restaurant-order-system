# Admin Console — Roles, Reach and the Shape of the Screens

What each kind of person sees when they sign in to `admin.yeyintlwin.com`, and why the
screens are shaped that way. This is the design behind the management console that grows
out of the sign-in page.

**Parent spec:** [2026-07-29-core-api-phase1-design.md](2026-07-29-core-api-phase1-design.md).
**Sibling:** [2026-08-05-admin-management-login-design.md](2026-08-05-admin-management-login-design.md),
which covers signing in. This document starts after that.

**Working mockup:** [2026-08-06-admin-console-roles-mockup.html](2026-08-06-admin-console-roles-mockup.html) —
one self-contained file, no build step. Open it in a browser. The **Viewing as** control at
the bottom of the sidebar switches between the four kinds of person; it is mockup
furniture and would not ship.

---

## 1. The hierarchy

```
Platform
 └── Company            exactly one CEO
      └── Shop          exactly one manager
           └── Staff
```

Four levels, and every level has a single person in charge of the level below it.

## 2. The one rule everything else follows

**Each person reaches exactly one level down, and no further.**

| Signed in as   | May manage                | May not touch          |
| -------------- | ------------------------- | ---------------------- |
| Platform owner | Companies and their CEOs  | Managers, staff        |
| CEO            | Shops, managers, staff    | Other companies        |
| Manager        | Staff at their own shop   | Their CEO, other shops |
| Staff          | Their own account only    | Everything else        |

### 2.1 The boundary is structural, not cosmetic

A person does not see a greyed-out control they are not allowed to use. **The screen does
not exist.**

- The platform owner's console has **no Users menu at all**. There is no page anywhere in
  their console that lists a manager or a member of staff.
- Staff have **no menu items whatsoever**. Signing in lands them on their own account
  page. The empty sidebar is the message: this console is not where they work.

### 2.2 Where a boundary is felt, it is stated

Omitting a field silently reads as an oversight. Each dialog carries one line naming the
limit:

- Manager editing a person: *"Only your CEO can make someone a manager or move them to
  another shop."*
- CEO editing a person: *"Managers are chosen on the Shops screen, not here."*
- Platform owner editing a company: *"You cannot see or change managers and staff. That is
  the CEO's job."*

### 2.3 The boundary changes the controls, not just the data

When the platform owner replaces a CEO, the new CEO is **typed in by name and address**.
There is no picker, because a picker would require listing the people inside a company —
which the platform owner may not do. The restriction is visible in the shape of the form.

## 3. A manager is a slot on the shop, not a badge on the person

The manager is chosen on **Shops → Edit → Manager**, never on a person's record.

This is what makes "one manager per shop" true by construction. There is one field, so
there can never be two managers, and never a second one nobody noticed.

### 3.1 Replacing a manager is one decision, not two

Choosing a different name reveals the other half of the decision immediately:

> **Thura Zaw will no longer manage Bogyoke.**
> What happens to their account?
> - Keep them here as staff
> - Suspend their access — they have left

Split into "demote the old one" then "promote the new one", the shop spends the gap with
two managers or none.

### 3.2 A shop with no manager is stated, never hidden

The Manager cell reads **No manager** in amber and the row's button says **Assign** rather
than Edit. A line above the table names every shop in that state and says who is carrying
them:

> *Insein has no manager. Until you appoint one, that shop is yours to run — you can
> already do everything a manager can there.*

The line stays until every slot is filled. It is not an error: the CEO is above the
manager, so the work still has somewhere to land. Saying so stops it reading as an
emergency.

Suspending a manager from the Users screen empties the shop's slot in the same action.
A person who can no longer sign in must not still be listed as running a shop.

## 4. Nobody is deleted

There is no delete control anywhere. A person who leaves is **suspended**.

Every order and audit entry they touched still points at their account. Deleting the row
breaks that history. Suspending keeps it and takes away the ability to sign in, which is
the part that actually matters.

The wording says so: *"Suspending someone keeps their record and their past orders."*

## 4A. What a form asks for

A creation form asks only for what the thing cannot exist without. Everything else waits
for the person who will know the answer.

### 4A.1 Adding a shop asks four things

| Field      | Required | Why                                                     |
| ---------- | -------- | ------------------------------------------------------- |
| Shop name  | Yes      | What everyone calls the branch. Goes on receipts.       |
| Address    | No       | Shown under the name everywhere the shop is listed.     |
| **Tables** | Yes      | The number creates the tables. See below.               |
| Manager    | No       | A branch is usually opened before the manager is hired. |

Phone, opening hours and the receipt footer are **not** asked for. Those belong to the
manager, and a CEO opening a branch would be guessing. The form says so:
*"Phone, opening hours and the receipt footer are the manager's to set."*

Requiring a manager would be worse than leaving it blank — CEOs would put their own name in
as a placeholder and the data would be a lie. §3.2 already handles the empty slot.

### 4A.2 Tables are created, not counted

The number is not a statistic. Entering 12 creates **Table 1 through Table 12**, each a
real record that can carry its own QR code. The hint says exactly that as the number is
typed, and on an existing shop it says what the change will do instead:

- adding: *"Adds 3 tables to the end of the list."*
- removing: *"Removes the last 3 tables. Their QR codes stop working."*

The second line matters. A printed QR code on a physical table stops working when the
record behind it goes, and nobody should discover that from a customer.

### 4A.3 The company's own mark

A CEO can set a **logo** for their company, at the top of their Settings — above the name,
because it is the one thing on that screen other people see. It replaces the initials
wherever the company is drawn: the CEO's own sidebar, and the platform owner's Companies
list, since it is the same company either way.

Initials remain the fallback, so nothing is ever blank. Uploads are capped at 2MB and
rejected with a reason rather than silently.

Shops do not get their own logo. A branch is part of a brand, not a brand.

### 4A.4 Every user has a phone number

Required on every person: staff, manager, CEO. In a restaurant the phone is how you
actually reach someone; the email address is only how the system recognises them.

Enforced in JavaScript rather than with the `required` attribute, because the field sits
inside containers that are hidden in some modes, and a browser refuses to report a
validation error on a control it cannot focus.

This sharpens §9.2 rather than answering it: if every person reliably has a phone and not
every person reliably has an email, the phone is the better sign-in name.

## 4B. Looking a record up

A row carries four or five columns. Everything else about a record lives at the top of that
record's own dialog, above the form, as **facts rather than fields** — a quiet read-only
block with a grey label and a value.

| Record  | Facts shown                                  |
| ------- | -------------------------------------------- |
| Person  | Added, Last seen                             |
| Shop    | Manager phone, Staff, Opened                 |
| Company | CEO, CEO phone, Email, Shops, Tables, Opened |

**Nothing appears twice.** A person's role and shop are in the dialog's subtitle and in its
fields already, so they are not repeated as facts; a shop's name, address, table count and
manager are all fields, so the facts carry only what the form cannot say.

### 4B.1 A phone number is there to be rung

Every phone number in a facts block is a `tel:` link.

Where the number is an editable field rather than a fact — a person's own phone — the link
sits under the field as *"Call this number"* and follows whatever is typed, appearing when
there is a number and going away when there is not. The number is never printed twice.

## 4C. Your own name is not yours to edit

Account settings shows your name **read-only**, with a line naming who to ask:

| Signed in as   | Name field | The line says                                    |
| -------------- | ---------- | ------------------------------------------------ |
| Platform owner | Editable   | *Nobody above you to ask, so this one is yours.* |
| CEO            | Read-only  | *Ask the platform owner to change this.*         |
| Manager        | Read-only  | *Ask your CEO to change this.*                   |
| Staff          | Read-only  | *Ask your manager to change this.*               |

Naming someone is the job of the person who answers for them. Left open, a name becomes a
nickname — and the person who has to recognise it on a rota, an order or a receipt is not
its owner.

Everything else on that screen stays the person's own: their phone, their password, their
sessions. Only the name, and only because other people read it.

The platform owner is the exception for the same reason they are the exception in §9.1 —
there is nobody above them to ask.

## 5. Passwords

Nobody can read anyone else's password. Helping someone in means **handing them a new
one**, and the person one level above does it.

| Who forgot     | Who fixes it       |
| -------------- | ------------------ |
| Staff          | Their manager      |
| Manager        | Their CEO          |
| CEO            | Platform owner     |
| Platform owner | **Nobody** — see §9.1 |

### 5.1 Passwords are read out, not emailed

This system has no mail server, so there is no reset link to send. The person doing the
reset is shown a generated password to pass on:

    Ginger-Pepper-4812

Two words and four digits: readable out loud across a noisy kitchen, short enough to write
on a pad, and long enough to survive until first sign-in. It appears directly under the
button that produced it, not back in the field used when adding someone.

### 5.2 Changing your own password is a task, not a row

Account settings shows one row — when the password last changed, and a **Change password**
button. The three fields open **in a dialog on top**.

An earlier version unfolded the fields into the settings list. It failed: the button that
caused it disappeared, the new rows looked exactly like the rows around them, and the
whole thing read as "the list got longer" rather than "something opened". A password
change has its own commit point, so it gets its own surface.

The dialog asks for the current password, the new one twice, and warns up front that other
devices will be signed out. Success shows a green line that is impossible to miss — the
version on the sign-in page was too quiet, and a successful change looked like a failure.

### 5.3 Promoting an existing person keeps their password

Typing an address that already has an account into **Replace CEO** hides the first-password
field and says:

> *This address already has an account. They keep their password and everything they have
> done, and are signed out once so the new role takes hold. If they run a shop, that shop
> is left without a manager for the new CEO to fill.*

Without this the system quietly makes a second account for the same person.

The check answers **taken or free, and nothing else**. It does not reveal the name, the
role or the shop — those stay inside the company (§6). That is why the wording is *"if they
run a shop"* rather than naming Bogyoke.

## 6. The platform owner sees CEOs only — decided, not defaulted

Considered and rejected: a full user list, and a logged exact-email lookup for support.

**Chosen: neither.** The platform owner's console lists companies and their CEOs. Nothing
else about the people inside a company is reachable.

The companies on this platform can be competitors. A CEO does not want the platform vendor
browsing their staff list, and the platform account is the one with no password-reset path
above it — the smaller its reach, the smaller the damage if it is taken.

**The cost, accepted knowingly:** when a company reports "our staff cannot sign in", the
platform owner cannot look. They hand it to that company's CEO. Revisit only if support
becomes genuinely painful, and then as read-only lookup by exact address with the CEO able
to see every look.

### 6.1 Shops and tables are not people

The boundary is about **who is inside a company**, not how large it is. The platform owner
sees, for every company:

- how many shops it has, and for each one its **name, address, manager and table count**
- how many tables in total

**Revised.** This section first said the platform owner saw only shop names and counts.
Managers were added deliberately: hosting a company means knowing who runs each branch, and
a name is not a control. Everything that acts on that person — their access, their password,
their shop, whether they are a manager at all — is still the CEO's alone, and there is still
no screen in the platform console that lists a person.

Their phone number is **not** shown. Knowing who runs a branch is not the same as being able
to ring past the CEO, and nobody has asked for that.

Clicking a company row opens its branches beneath it. **One at a time** — opening another
closes the last, so the table never grows into a list of everything.

Three attempts, and the first two both failed for the same reason: neither the affordance
nor the state was visible.

1. **Behind the shop count.** Only the digit was clickable, nothing said it could be, and
   nothing said whether it was. A count you have to discover is a count nobody checks.
2. **Always expanded.** Nine rows to read three companies, and with fifty companies it is
   not a table any more.
3. **A row that opens, and says so.** The whole row is the target. A triangle turns and
   goes green, the open row is tinted, and only one is ever open.

What was missing both times was not the amount of information. It was the two things a
disclosure has to say: *this opens*, and *this one is open*.

Each branch prints its table figure in the same column as its company's total, so the parts
line up under the sum they add to. The Edit button keeps its own click — an action inside a
row beats the row.

When the numbers change underneath it, an open row reopens rather than closing, so the
branches always match the sum next to them.

This is what the platform is hosting and, eventually, what it would bill for. Nothing here
names a manager or a member of staff, so §6 is untouched.

The figures for a company are **summed from its shops, never typed**. The CEO adds a branch
with 16 tables and the platform owner's totals move with it; there is no second copy to
drift.

## 7. Screen vocabulary

The same screen is named for the person reading it. A manager's people page is titled
**Staff** with an **Add staff** button, because staff is all they can add. A CEO's is
titled **Users** with **Add user**, because they add managers too. The label states the
limit before the person tries to cross it.

Each navigation link carries its own heading and its own primary action, so a screen and
its button never drift apart.

## 8. The screens

### 8.1 Sidebar

Company or platform name and scope at the top, navigation in the middle, the signed-in
person at the bottom. Clicking the person opens **Account settings**, which is a different
thing from **Settings** — the first is yours, the second is the company's or the
platform's.

The scope block shows what it says. A platform owner sees **Restaurant OS / Platform**, not
a company they do not belong to.

### 8.2 Responsive

| Width         | Sidebar             | Tables      |
| ------------- | ------------------- | ----------- |
| 901px and up  | Permanent column    | Table       |
| 641 – 900px   | Drawer behind ☰     | Table       |
| 640px or less | Drawer behind ☰     | Stacked list |

Decisions worth keeping, each one found by a defect:

- **Input text is 16px by default**, dropping to 13.5px only behind
  `(hover:hover) and (pointer:fine)`. A width query never catches an iPhone, which is
  667–932px wide in landscape; below 16px iOS Safari zooms the page in on focus and does
  not zoom back out.
- **The two drawer media queries are exact complements** — `(max-width:900px)` and
  `not all and (max-width:900px)`. Written as `901px`, fractional widths such as 900.5 —
  routine on a 150%-scaled Windows display — match neither, and the scrim covers the
  desktop layout with no way to dismiss it.
- **The rail carries the left safe-area inset at every width.** A Pro Max in landscape is
  932px, which is the permanent-column layout, not the drawer one.
- **Hover-reveal only where a pointer exists.** The Edit button is always visible on touch
  and always visible in the stacked list, and is a 44px square target.
- **The drawer's `visibility` flips late on close and instantly on open**, so focus can
  move into it in the same tick it opens. A plain `visibility .22s` leaves it hidden for
  half the animation and silently swallows the `.focus()` call.
- **`overscroll-behavior-y` on the page and its scrollers**, or a downward swipe at the top
  of a list reloads the page on Chrome Android.
- **`[hidden] { display: none !important }`.** The browser's own `hidden` rule loses to any
  author `display`, so a `display:grid` row stays on screen while claiming to be hidden.

### 8.3 Dialogs

Discrete tasks with a commit point open in a native `<dialog>` via `showModal()`, which
brings the focus trap, the Escape key and an inert background with it. The row that opened
it stays visible behind, so the cause of what appeared is never in doubt. Closing by any
route clears whatever was typed.

## 9. Open questions

### 9.1 The platform owner has nobody above them

If the platform owner forgets their password there is no one to reset it. This is not
hypothetical: it happened in production on 2026-08-05 and was fixed with SQL on the box —
no audit trail, no guard rails.

Not designed yet. Needs a recovery path that does not amount to a second permanent
super-account.

### 9.2 Does every member of staff have an email address?

Sign-in is by email throughout. Restaurant floor staff may not have one, and a manager
inventing addresses on their behalf is a bad answer. Worth considering a phone number, or a
sign-in name the manager assigns.

### 9.3 Not designed yet

- What "Suspend a company" does to sessions already open inside it.
- Whether a CEO may reassign a person between shops while they hold a manager slot.
- Managing tables one at a time — renaming them, taking one out of service, reprinting a
  QR code. §4A.2 creates them in a block; nothing edits them individually yet.
- Whether removing tables should be blocked while a table has an open session.
