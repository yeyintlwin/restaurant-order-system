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

There are two kinds of thing in that diagram, and they do not obey the same rule.

**Places** — a company, a shop, a table — are **built by the platform owner**. They are the
thing being hosted, and fitting one out is an operator's job: rows in a database, e-paper
screens on the tables, QR codes that have to be printed.

**People** — CEO, manager, staff — are **appointed one level down at a time**. Nobody
reaches past the level below them, and nobody sees inside the level below that.

| Signed in as   | May manage                          | May not touch                 |
| -------------- | ----------------------------------- | ----------------------------- |
| Platform owner | Companies, their CEOs, their shops  | Managers, staff               |
| CEO            | Managers and staff; the manager slot on each shop | Other companies; opening or closing a branch |
| Manager        | Staff at their own shop             | Their CEO, other shops        |
| Staff          | Their own account only              | Everything else               |

**Revised.** This first read *"each person reaches exactly one level down, and no further"*,
and shops were the CEO's to open. That was wrong about who actually does the work. Setting a
branch up is a systems job — tables, screens, codes — and a CEO opening a branch had no way
to do any of it. The rule that replaced it is the one above, and it is why the platform
owner can create a shop two levels below them while still being unable to see a single
person inside that company.

The split holds at the join: **the platform owner opens the branch, the CEO chooses who runs
it.** Neither can do the other's half, and the shop dialog is literally cut along that line.

### 2.1 The boundary is structural, not cosmetic

A person does not see a greyed-out control they are not allowed to use. **The screen does
not exist.**

- The platform owner's console has **no Users menu at all**. There is no page anywhere in
  their console that lists a manager or a member of staff.
- Staff have **nothing but the Dashboard**. No shops, no people, no settings — signing in
  shows them one screen and their own account.

### 2.2 Everyone lands on a Dashboard

The first item in every sidebar, for every level, and the screen the console opens on.

It is **empty on purpose** and says so: *"Nothing here yet."* A placeholder that admits it
is a placeholder is honest. A grid of invented numbers would be read as real the moment
anyone looked at it, and someone would make a decision on it.

What belongs on it differs by level and is not yet decided, so nothing has been guessed.

### 2.2 Where a boundary is felt, it is stated

Omitting a field silently reads as an oversight. Each dialog carries one line naming the
limit:

- Manager editing a person: *"Only your CEO can make someone a manager or move them to
  another shop."*
- CEO editing a person: *"Managers are chosen on the Shops screen, not here."*
- Platform owner editing a company: *"You cannot see or change managers and staff. That is
  the CEO's job."*
- Platform owner editing a shop: *"Who manages this shop is the CEO's to choose. You do not
  see the people inside a company."*
- CEO editing a shop: *"The name, address and number of tables are the platform owner's to
  set. Phone, opening hours and the receipt footer are the manager's."*

The last two are the same dialog read by two people. Each names the person whose job the
other half is, so neither reads as a gap in the screen.

### 2.3 The boundary changes the controls, not just the data

When the platform owner replaces a CEO, the new CEO is **typed in by name and address**.
There is no picker, because a picker would require listing the people inside a company —
which the platform owner may not do. The restriction is visible in the shape of the form.

## 3. A manager is a slot on the shop, not a badge on the person

The manager is chosen on **Shops → Edit → Manager**, never on a person's record.

This is what makes "one manager per shop" true by construction. There is one field, so
there can never be two managers, and never a second one nobody noticed.

**The route survives §2's revision unchanged, and the argument gets stronger.** A CEO still
goes Shops → Edit → Manager. What changed is that there is now **nothing else on that
screen**: Manager is not merely the field that makes one-manager-per-shop true, it is the
only field the CEO has there at all. The name, the address and the table count sit above it
as facts.

### 3.0 A manager may run two shops, and the list says who already runs what

**Reversed.** This briefly forbade it — anyone holding a shop was greyed out, on the
reasoning that a person cannot stand on two floors.

Real restaurants do not work like that. When a chain opens a branch, the CEO sends the
manager whose shop is already steady: *"you take the new one, this place runs itself now."*
For a while that person holds both. **Forbidding it does not prevent the arrangement — it
just means the arrangement stops being written down**, and the console shows a shop with no
manager while somebody is plainly managing it.

So the label informs and does not block:

> Ko Ko Naing — also manages Hledan

The same sentence doing the opposite job. Before it explained a refusal; now it is what a
CEO needs to know before deciding, and the deciding is theirs.

**The shops are the slots, not a field on the person.** A manager's shops are read back from
the shop rows that name them — the Users list says *"Bogyoke and Insein"* because those two
slots hold that name, not because anything was written on the manager. A handover therefore
cannot leave a stale second copy behind.

Two consequences fall out and both are handled:

- **The CEO's person dialog no longer offers a Shop field for a manager.** A single-value
  picker would collapse two shops into whichever one it happened to be showing. The limit
  line says where the decision lives: *"Which shops this manager runs is set on the Shops
  screen, one shop at a time. They can run more than one."*
- **Suspending a manager empties every slot they hold**, not one. Clearing the first and
  leaving the second would leave a shop being run by somebody who can no longer sign in —
  the exact failure §3.2 exists to prevent, just harder to notice.

### 3.0.1 Two shops is a switch, not a bigger screen

Every screen a manager has is about **one** shop: their staff, the shop's phone, its hours,
its receipt footer, the country it is in. So holding two does not make those screens larger.
It adds a question — *which one am I looking at?* — and the honest place for that is the
line in the rail that already answers it.

The shop name under the company becomes a picker, **only when there is a second shop to
pick**. A picker with one option pretends there is a choice, and the first thing anyone does
with it is open it to find out there is not.

It is deliberately the same size and colour as the text it replaces. The rail does not grow
a widget; the same line starts answering back.

Switching repaints everything shop-shaped at once: the staff list, the shop settings, and
the language default in Account settings — which follows the shop you are in, so a manager
of a Yangon branch and a Bangkok one sees the right default on each.

The manager's staff list is **read off the CEO's own Users table**, filtered to the selected
shop. A second hand-written copy would be one switch away from disagreeing with the list it
came from — the same bargain the shop tree already makes (§6.2).

Freeing someone remains the same two levers: replace them on a shop (§3.1), or suspend them
from the Users screen (§3.2).

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

### 4A.1 Opening a branch asks four things, and never a person

The **platform owner** fills this in, from inside the company the branch belongs to.

| Field         | Required | Why                                                            |
| ------------- | -------- | -------------------------------------------------------------- |
| Shop name     | Yes      | What everyone calls the branch. Goes on receipts.              |
| URL name      | Yes      | The name that goes in an address. See §4D.                     |
| Address       | No       | Shown under the name everywhere the shop is listed.            |
| **Tables**    | Yes      | The number creates the tables. See below.                      |
| **Time zone** | Yes      | When this branch's business day starts and ends. §7A.          |
| **Currency**  | Yes      | What its prices and receipts are in. §7A.                      |
| **Language**  | Yes      | What everyone here starts in. §7A.                             |

The last three are grouped under **Where this branch is** — they are one decision about one
country, made once, and reading them as a block is how that comes across.

**There is no manager field at all.** Not optional — absent. The platform owner may not see
the people inside a company, so there is nobody for a picker to list.

That makes something true by construction that used to be a kindness: **a shop is always
born without a manager.** It appears on the CEO's Shops screen in amber, and the notice at
§3.2 names it as work waiting for them. The handoff between the two roles is that line.

Phone, opening hours and the receipt footer are not asked for either. Those belong to the
manager, and an operator fitting out a branch has never been there.

A blank name is refused **out loud** — *"A branch needs a name."* An earlier version returned
silently, which reads as a broken button.

### 4A.2 Tables are created, not counted

The number is not a statistic. Entering 12 creates **Table 1 through Table 12**, each a
real record that can carry its own QR code. The hint says exactly that as the number is
typed, and on an existing shop it says what the change will do instead:

- adding: *"Adds 3 tables to the end of the list."*
- removing: *"Removes the last 3 tables. Their QR codes stop working."*

The second line matters more now than when it was written. It was aimed at a CEO who knows
the branch; the reader is now an operator who may never have stood in it. A printed QR code
on a physical table stops working when the record behind it goes, and nobody should discover
that from a customer.

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

**Nothing appears twice as a field and a fact.** A person's role and shop are in the
dialog's subtitle and in its fields already, so they are not repeated as facts.

**Amended.** A shop's name, address and table count used to be fields, so the facts carried
only what the form could not say. They are no longer the CEO's fields. In the CEO's shop
dialog they now appear as facts — above a form whose only control is the manager.

That means a CEO who goes Details → Edit reads the address twice, one dialog after the
other. Accepted, and the rule is narrowed rather than broken: **a value repeated because it
is no longer yours to change is not a duplicate.** The second showing is doing different
work — the first told them what the shop is, the second tells them what they cannot alter
about it while they alter the one thing they can.

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

## 4D. URL names

Every company and every branch carries a second name, typed by the **platform owner** when
it is opened: the one that goes in an address. "Shwe Café" has a space and an accent, and
neither survives a path.

### 4D.1 The scheme is nested, so a clash is impossible rather than unlikely

```text
/sakura                     a company  — unique across the platform
/sakura/bogyoke             a branch   — unique inside its company only
/sakura/bogyoke/t3          a table    — unique inside its branch only
```

Nothing is ever checked against everything. Each name only has to be unlike its siblings,
because the names above it are already in front of it.

That buys two things at once. **Two chains can each have a downtown branch** and neither has
to give way. And **"taken" never leaks across companies** — a CEO's branch names are not
tested against a competitor's, so the check cannot become an existence oracle the way the
platform boundary worries about elsewhere.

Considered and rejected: one flat namespace where every name on the platform is unique.
Shorter URLs, but the second chain to open a Bogyoke branch is told the name is taken by
someone they cannot see, and ends up as `bogyoke-2` forever.

### 4D.2 Tables are not typed

The table count on the branch form already creates them, so they are `t1` … `t12`. No form
anywhere asks for twelve names, because no one would fill it in honestly.

### 4D.3 The rules, and where they are explained

| Rule | Refused with |
| ---- | ------------ |
| Lower case only | *Lower case only.* |
| No spaces | *No spaces. Use a hyphen instead.* |
| Letters, digits, hyphens; starts with a letter | *Letters, numbers and hyphens only, starting with a letter.* |
| No trailing hyphen | *Cannot end with a hyphen.* |
| No doubled hyphens | *No double hyphens.* |
| 2–24 characters | *Too short* / *Too long* |
| Unique among its siblings | *That name is taken.* |
| Nothing already in the path | *The company is already in the address. Drop the "sakura-".* |

The last one is the "nothing unnecessary" rule made enforceable: a branch called
`sakura-bogyoke` inside `sakura` builds `/sakura/sakura-bogyoke`, twice the length and none
of the meaning.

**But the rules are not the explanation.** Under the field is the address being built, and
it assembles as you type:

    order.yeyintlwin.com/sakura/bogyoke

A rule you read is a rule you forget. A URL you watch assemble is one you understand — and
it is what makes a redundant name look wrong before any message says so.

### 4D.4 Suggested, then left alone

The field fills itself from the display name — `Shwe Café` → `shwe-cafe` — and **stops the
moment the operator edits it**. A field that keeps rewriting what you typed is worse than
one that never helped.

Burmese script suggests nothing at all; it maps to no ASCII, so the box stays empty and the
operator types their own. That was always allowed, and it is why the field is a real input
rather than a generated label.

### 4D.5 Read back later, not only while typing

A branch's sheet carries **Address on the web** the way it carries its street address, and a
company's sheet carries its URL name. An identifier you can only see while creating it is
one nobody can check afterwards.

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
- **the manager's phone number**, as a `tel:` link
- how many tables in total

**Revised three times.** This section first said the platform owner saw only shop names and
counts, then added managers by name, then their phone — and now says they open the branch in
the first place.

The line that survived the first three revisions was *"seeing is not managing"*. Half of it
is now gone and the other half is the whole point:

> **Places are managed. People are only ever seen.**

The platform owner creates, renames and re-sizes a shop. They still cannot touch a single
person in it: not their access, not their password, not which shop they run, not whether
they are a manager at all. **There is still no screen anywhere in the platform console that
lists a person or edits one**, and the shop form has no manager field — so a branch is
opened, fitted with tables and handed over without its operator ever meeting anybody.

What the platform owner has beyond that is a way to *reach* the people running the branches
it hosts, which is what an operator needs when a branch stops sending orders at nine on a
Friday.

**The cost of the wider reach, stated rather than left implied.** §6 keeps the platform
console small partly because that account has no password-reset path above it (§9.1). The
reach just grew: a stolen platform account can now rename every shop on the platform, and
§4A.2 means shrinking a table count destroys table records and kills their printed QR codes.
That is a company's floor taken offline by an account that was recovered with raw SQL on the
box the last time it was lost. This does not reverse the decision — the work has to live
somewhere and it is genuinely operator work — but §9.1 stops being a tidy loose end and
becomes the most expensive thing on the open-questions list.

Clicking a company row opens its branches beneath it. **One at a time** — opening another
closes the last, so the table never grows into a list of everything.

**The last thing hanging off the trunk is `+ Add branch`**, and it takes the closing elbow.
A group ends with the way to add to it. That also means a company with no shops at all still
shows one line, and it is the line that fixes the emptiness — the old empty state said *"No
shops yet."* and dead-ended.

It carries a plus rather than the branches' `›`: this line makes something, it does not open
something. The whole row is the button, so the keyboard lands on the row rather than on a
26px ring floating at the far right of a line whose words are on the left.

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
line up under the sum they add to.

**The branches are a tree, not a nested table.** This took three tries and the first two
were the same mistake in different clothes.

Laying the branches out in the parent's columns meant two of those columns quietly changed
meaning — Company became Shop, CEO became Manager — so a manager's name read as a second
CEO. The fix looked obvious: give the group its own header row. But a header row plus an
Actions column *inside* an Actions column produced one table that looked like two nested
together, and reading it took real effort. Making the header a darker band only made the
nesting more emphatic.

The answer was to stop pretending it is a table. **A branch spans the whole row and hangs
off a line**, the way a folder shows what is inside it:

```text
▾ SK  Sakura Kitchen   Khin Myat      3   40   Active   Details  Edit
      ├─ Bogyoke       Thura Zaw · 12 tables                     Details
      ├─ Hledan        Ko Ko Naing · 8 tables                    Details
      └─ Insein        No manager · 20 tables                    Details
   MG Mandalay Grill   Nay Lin        1   10   Active   Details  Edit
```

Nothing lines up under the parent's columns, so nothing claims to be the same kind of thing
as the parent's values, and no second header is needed to explain what changed. The trunk
runs down through the group and stops at the last elbow, which is what says where the group
ends — no tint, no band, no extra rules.

The last branch is **marked in code**, not selected with `:last-of-type`, which on a `tr`
means "the last row in the table" and would have quietly matched nothing.

### 6.2 The CEO's shops open the same way

```text
Shop            Manager        Tables  Staff  Status   Actions
▾ BG  Bogyoke   Thura Zaw        12      2    Active   Details Edit
                  ├─ Aye Aye Mon   Staff                       ›
                  └─ Min Min       Staff · Suspended           ›
   HL  Hledan   Ko Ko Naing        8      1    Active   Details Edit
```

**Staff descend from the Manager column**, not from the shop's name. The first attempt put
the manager in as a node of its own with the staff beneath — a proper two-level tree, and
it printed the manager twice: once in the row's Manager column and again three pixels
below.

The fix is positional. A staff row leaves the first cell empty and starts its cell at the
Manager column, so the trunk lands directly under the name already printed there. The
hierarchy is stated by where the line falls rather than by repeating the person it belongs
to.

A shop with no manager keeps the same geometry — the staff descend from the words *No
manager*, which is exactly right. An empty shop says *Nobody here yet.*

The tree is read off the CEO's own Users table rather than kept as a second copy, so it can
never disagree with the list it came from. Each person opens their own sheet, the same one
the Users list opens.

**A branch row opens its own sheet** — address, manager, manager's phone, tables. The row
itself is the control and carries a `›`, not a button spelling out what pressing it does;
that is the same bargain the cards make on a phone. The `›` is a real button so the keyboard
can reach it.

**That sheet has an Edit**, and it opens the place: name, address, table count. This
reverses what this paragraph used to say. What did not move is the line beside the manager:
on this sheet the manager is a **fact with no control next to it**, and their phone number
stays a link for the reason it was always there.

**The company's own sheet lists branches only where the tree does not.** On a wide screen
the row behind the dialog already shows every branch with its manager, so printing them
again in the dialog is the same list twice, three inches apart. In card layout there is no
tree, so there the Shops section stays and each line opens the same branch sheet.

**Which is why `Add a branch` has two homes, and that duplication is accepted rather than
overlooked.** Below the card boundary the tree does not render at all and no row carries an
action, so the company sheet is the *only* place a branch can be opened. The line sits after
the total, so the sum still reads as the sum of the list above it.

That sheet is also why the list stopped carrying everything. It used to print manager,
tables, phone and address into two crammed lines per branch; it now prints the branch and
its table count, and the line opens.

Considered and rejected: labelling each cell inline (*"Manager · Thura Zaw"*), which repeats
the word down the list; and dropping the columns entirely for one sentence per branch, which
would have cost the alignment that makes the table counts read as parts of the sum. The Edit button keeps its own click — an action inside a
row beats the row.

When the numbers change underneath it, an open row reopens rather than closing, so the
branches always match the sum next to them.

This is what the platform is hosting and, eventually, what it would bill for. Nothing here
names a manager or a member of staff, so §6 is untouched.

The figures for a company are **summed from its shops, never typed**. The platform owner
adds a branch with 16 tables and the totals they are looking at move with it; there is no
second copy to drift.

## 7. Screen vocabulary

The same screen is named for the person reading it. A manager's people page is titled
**Staff** with an **Add staff** button, because staff is all they can add. A CEO's is
titled **Users** with **Add user**, because they add managers too. The label states the
limit before the person tries to cross it.

Each navigation link carries its own heading and its own primary action, so a screen and
its button never drift apart.

**A screen with nothing to add has no button.** The CEO's Shops screen keeps its heading and
loses its action entirely — not greyed out, absent — which is the same mechanism Dashboard
and Settings already use. The screen is now a place to read a branch and appoint the one
person in it.

When a CEO has no branches at all, the table is replaced by a line that says who opens them:
*"No branches yet. The platform owner opens your branches. As soon as one exists it appears
here, waiting for you to choose who manages it."* An empty table with no Add button would
otherwise read as something that failed to load.

## 8. The screens

### 8.1 Sidebar

Company or platform name and scope at the top, navigation in the middle, the signed-in
person at the bottom. Clicking the person opens **Account settings**, which is a different
thing from **Settings** — the first is yours, the second is the company's or the
platform's.

The scope block shows what it says. A platform owner sees **Restaurant OS / Platform**, not
a company they do not belong to.

### 8.2 Responsive

**Corrected.** This table used to say tables fold into cards at 640px. They never did — the
card boundary is **1049px**, and it is deliberately not aligned with the drawer's 900px.
Three independent boundaries, each set by what actually breaks at it:

| Width          | Sidebar          | Tables       | Also                        |
| -------------- | ---------------- | ------------ | --------------------------- |
| 1050px and up  | Permanent column | Table        |                             |
| 901 – 1049px   | Permanent column | Stacked list |                             |
| 641 – 900px    | Drawer behind ☰  | Stacked list |                             |
| 640px or less  | Drawer behind ☰  | Stacked list | Tighter gutters and dialogs |

The 1049px figure catches an iPad in portrait (1024px) and a half-width desktop window,
which is the point. It also means the branch tree **does** render on a touch device — an
iPad in landscape is 1366px — so every control in it carries a 44px target.

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
- **Row actions exist above 1049px only, and hover-reveal is gone everywhere.** An Edit
  button is always visible, grey until hover or keyboard focus, and at least 44px. Below
  1049px there are **no row actions at all** — the whole Actions column is hidden and the
  card itself opens the record's sheet, where Edit lives. This corrects an earlier bullet
  that claimed hover-reveal and a visible Edit in the stacked list; neither was ever true.
  It is also the rule that shapes this change: **every power that moved had to be reachable
  from a facts sheet, or it would not exist on a stacked screen.** Both are — the platform
  owner's Edit on the branch sheet, and the CEO's manager form behind the shop sheet's Edit.
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

## 7A. Time zone, currency and language belong to the shop

**Revised, and the reason is one sentence: a chain can open a branch in another country.**

These three sat on the company. That was wrong the moment Sakura Kitchen put a branch in
Bangkok. A business day rolling over at 06:00 Yangon is the wrong day in Thailand, the
receipts print the wrong money, and the staff read a language chosen two borders away.

They now sit on the **shop**, and the **platform owner** sets them, when the branch is
opened. The CEO does not set them at all, for the same reason they do not set opening hours:
they would be guessing, and guessing once per country.

`core-api` already agreed. `shops.time_zone` and `shops.business_day_rollover_hour` are
NOT NULL columns **on the shops table**, and have been since the first migration. The
console was the only place that pretended a company had one time zone. Currency exists
nowhere yet.

### 7A.1 They are the branch's country, not its settings — so the manager reads them

**Revised once more.** These briefly belonged to the manager, on the argument that the
person standing in Bangkok knows it is Bangkok. True, and beside the point: **nobody changes
a currency on a Tuesday.**

What a manager would actually do with three dropdowns they never need is open one by
accident. The damage is not cosmetic — the wrong time zone moves when the business day rolls
over, and the wrong currency reprices the whole menu. A control nobody needs weekly, that
breaks the shop when mistyped, belongs with the operator who opened the place.

So the manager's Settings screen shows all three as **read-only**, with a line naming who to
ask. Shown rather than removed, because a manager has to *know* their shop runs on Bangkok
time and prices in baht — and a value you cannot find anywhere is indistinguishable from one
nobody set.

### 7A.2 All three are asked when the branch opens, and none of them defaults past you

They are grouped on the form under **Where this branch is**, with one line saying what they
are: *"Set once, when the branch opens. Its manager can read these but not change them."*

Each starts **empty**, and each is refused by name — *"A branch needs a currency before it
can open."* Somebody opening in Bangkok should have to choose Bangkok, not fail to notice
that Yangon was already sitting in the box. Three deliberate choices, once, for a decision
that outlives everyone who makes it.

They stay editable on the platform owner's branch form afterwards. That is the only repair
path there is: the CEO cannot change them and the manager cannot either, so if one is wrong
the operator who set it is the one who fixes it.

### 7A.2 Language is two settings, one above the other

| Setting | Who sets it | Where | What it means |
| ------- | ----------- | ----- | ------------- |
| **Shop language** | The platform owner | The branch form, when it opens | What everyone at this shop **starts** in |
| **Your language** | Every person | Account settings | What **you** read the console in |

Only the first row changed hands. Which language a branch runs in is a fact about where it
is, like its time zone and its money. Which language *you* read is yours, always.

The second overrides the first, for one person, and nobody else notices.

This follows §8.1's existing division exactly: **Settings is the place's, Account settings
is yours.**

### 7A.3 "Shop default" is a real state, not a pre-selected language

A person's Language list opens with an option that is not a language:

    Shop default — ไทย — Thai

This matters more than it looks. It is the difference between *"I have not chosen"* and
*"I chose Thai"*, and the two behave differently the day the shop's language changes:
everyone who never chose **moves with it**, and everyone who did **stays put**.

Collapse it into a plain pre-selected language and the two states become
indistinguishable — identical on the day, and the link silently cut forever. Nobody would
find out until a branch was switched to Thai and half the staff did not follow.

The line under the field says which state you are in:

- Not chosen: *"Following Bogyoke. Choose one and only your own console changes."*
- Chosen: *"Yours only. Everyone else at Bogyoke still reads ไทย — Thai."*

### 7A.4 A CEO belongs to no shop, so has no default

Managers and staff belong to a shop and inherit its language. A **CEO belongs to none** —
they are above all of them — and the **platform owner** belongs to no company. Neither is
offered a default; both pick outright.

That is not a special case bolted on. It is what *"nobody above you"* looks like on every
screen it touches: the same shape as the name field, where the platform owner is the one
person allowed to edit their own (§4C).

### 7A.5 What is left on the CEO's Settings screen

The logo and the company name — the mark other people see, and the words on the receipt.
That is genuinely all a company is once its branches carry their own country. The screen
says so rather than looking thin by accident:

> *A branch keeps its own time zone, currency and language — they belong to the country it
> is in, and are set when the branch is opened.*

### 7A.3 The platform's Settings screen is now empty, and says so

Its only row was the console language, which has moved to Account settings with everyone
else's. Nothing the platform sets reaches inside a company, and there is **no platform-wide
default language** either — a company's language is chosen by the CEO who bought it, not
inherited from the vendor.

Considered and rejected: keeping a platform-level default as a third rung above the company.
It would have filled the screen, but it invents a fallback nobody asked for and would have to
be right for Japan, Thailand and Myanmar at once. The screen admits it is empty instead, the
same way the Dashboard does.

## 8A. Renaming a shop reaches inside a company

Worth writing down because it is the one place this change can do damage invisibly.

In the mockup a shop has no id. Its identity is its **name**, held as a string in six
unrelated places that nothing joins: the shop row, the row's `data-shop`, every person's
`data-shop`, the Shop picker's options, the opened-on date, and the signed-in person's own
scope. Renaming used to be the CEO's own action inside their own company, so a stale string
was a bug. It is now done by someone who **cannot see any of the people it would strand**.

Left alone, renaming Bogyoke would empty its staff tree, break the promise in §3.2 that
suspending a manager clears the shop's slot, and leave the CEO's Users list naming a branch
that no longer exists — with nothing on the platform owner's screen to show for it.

**So the rename fans out to every holder of the string, in the same action.** Verified in
the browser: after a rename, all three people at that shop follow it, the Users list, the
Shop picker and the staff tree all move with them.

For the real service this is the argument for a shop id. A name is a label, not a key, and
the moment an actor outside the company can change it, every join built on it is a liability.

## 8B. What the API needs — recorded, not built

The console is design work; nothing here has been implemented in `core-api`. Two facts, and
they point in opposite directions.

**The platform owner creating a shop already works.** A platform admin selects a company and
is then treated as ranking above that company's CEO, so the existing create-a-shop route
admits them with no change. No migration, no new role, no schema work.

**Taking it away from the CEO does not.** That route admits both today, and there is no way
to say *"a platform admin acting inside a company, but not the company's own admin"* —
the four role aliases cannot express it. Something has to be added.

Two shapes, for whoever writes that plan:

1. **A fifth alias** meaning *scoped platform admin only*, applied to shop create, shop
   update, and the table routes underneath them. Smallest change; keeps shops on the tenant
   side of the API where the per-company guard already runs.
2. **Move the routes under the platform namespace**, nested inside the company they belong
   to. Reads truer against the new rule, and needs no scope switch — but it takes shops out
   from behind the tenant choke point that every other company-scoped route passes through.

**Recommended: the first.** The guard is the valuable part and shops should keep it.

Unresolved and belonging to that plan, not this one: whether a CEO keeps *read* access to a
shop record (they must — they read it to appoint a manager), and whether renaming a shop
needs to be an audited action given §8A.

**URL names need a column on companies and one on shops, with two different uniqueness
rules.** The company's is unique across the platform; the shop's is unique **within its
company** — a compound key, not a global one. Getting that wrong in the schema is how the
nesting quietly collapses into a flat namespace and one chain starts blocking another's
branch names. Tables need no column: `t1` … `tN` is derived from the count that created
them.

Neither column exists. The `0001_init` schema keys companies and shops on name, which is a
display string and is not URL-safe.

**A manager may hold more than one shop, so there is no constraint to add — and that is a
change of plan, not an absence of one.** An earlier draft asked for a unique partial index
on the shop's manager column to enforce one-person-one-shop. **Do not add it.** §3.0 now
allows the arrangement a CEO actually makes when a branch opens, and an index would refuse
it at the database, where the console could not explain why.

What does need care is the read: a manager's shops are the slots that name them, so the
Users list and every "which shops does this person run" question is a query over shops, not
a column on the user. Storing it twice is how the two disagree.

**Suspending a manager must clear every slot they hold, in the same transaction.** One
slot was enough while one was all they could hold. Now, clearing the first and leaving the
second leaves a shop run by an account that cannot sign in.

**Language and currency go on the SHOP, beside the time zone that is already there.**
`shops.time_zone` exists and is NOT NULL; `shops.currency` and `shops.language` do not exist
at all. Putting either on the company would be the mistake §7A just undid — a chain with a
Bangkok branch has no single currency.

**The user's own language needs a nullable column.** Null is what *"following my shop"* is.
§7A.3 is a data shape before it is a screen: store the resolved language instead and the
link silently dies the day a manager changes the shop's.

Nothing else about the identity slice changes. A language is a preference, not a permission,
and every person may set their own.

**The shop's three are written by the platform owner and by nobody else** — not the CEO, not
the manager. That is the same role question as the rest of the shop record, so it does not
add a second one: the whole of a shop's own row moves to the scoped platform admin, and what
stays with the CEO is the manager slot, which lives on a different route.

Worth stating because a "read-only for the manager" screen is a UI fact, not a guarantee.
The route has to refuse a manager's write, or the read-only fields are decoration.

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
- **Closing a branch.** Nothing anywhere deletes a shop, and §4 says nobody is deleted.
  Suspending a person is settled; suspending a *place* is not, and the platform owner is now
  the one who would do it.
- **Where a platform owner lands after saving on a phone.** Their route is Companies →
  company sheet → branch sheet → shop form, and the sheet replaces itself in place with no
  way back. Saving currently drops them on the Companies list. Tolerable at depth two, which
  is all it used to be.
- **Whether a CEO should be told a branch was opened for them.** The shop simply appears in
  their list, in amber, waiting. That is honest but silent, and the two people are not in the
  same building.
- **The branch form is now the longest dialog in the console** — about 1150px of content
  against a 766px viewport on a laptop, so the Save button is below the fold. It scrolls, and
  the company dialog already overflowed before any of this, so nothing here is new or broken.
  But if a sticky footer is ever the answer, it is the answer for every dialog at once, not
  for this one.
