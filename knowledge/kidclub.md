# KidClub, the business (for Atlas)

What Atlas needs to know to answer Renato and Marisa about KidClub. Learned from the noisysource monorepo
(`packages/shared/models/`, `functions/src/kidclub/`, the apps' CLAUDE.md and STATUS.md); when a detail isn't
here, read the code (code_notes / code_ask on noisysource/noisysource) or the data itself.

## The business
- KidClub is "Arco-Íris da Pequenada", a children's centre in Coimbra, owned by **Noisy Phocus**, Renato and
  Marisa's company. **NoisySource** is the IT company that runs its systems and pays for the cloud.
- It sells: the **study room** (after-school tutoring, monthly subscriptions by weekday), **school transport**
  (monthly subscriptions, trips per weekday), **camps** (summer/Christmas, deposit then balance), **birthday
  parties** (bookings, with a deposit), and one-off **events**. A child's first month also carries the
  **enrollment** fee (registration + insurance).
- Families pay through Easypay (MB WAY, Multibanco, card) or bank transfer; invoices are issued in **Vendus**
  (Atlas reads Vendus with the vendus_* tools, read-only).

## Where the data is (Firestore, `(default)` database)
- Environments: **dev** = project `kidclub-dev` (test data; Atlas may change it after an OK), **prod** =
  `rainbow-prod-2454b` (the real business; changes need their explicit OK on a card, and only when prod changes
  are switched on). Which are connected, and under which names, is at the end of the prompt.
- Everything of KidClub is under `_apps/arcoiris/`:
  - `families/{id}`: the paying family. `primaryContact` (name, email, phone), `nif` (tax id; missing, blank or
    `999999990` = invoiced as "Consumidor final"), `billingAddress`, `paymentMethod`, `status`
    (active | inactive | suspended), `createdAt`.
  - `children/{id}`: `familyId`, `firstName`, `lastName`, `schoolName`, `schoolYear`, `status`
    (active | inactive | graduated). Health fields are hidden from Atlas on purpose.
  - `studyroom/{id}`: study room subscriptions: `familyId`, `childId`, `childName`, `schoolName`, `days`
    (weekday and hour), `monthlyPrice`, `status` (pending | active | cancelled).
  - `transportationSubscriptions/{id}`: transport subscriptions: `familyId`, `childId`, `childName`,
    `startDate` / `endDate` (yyyy-mm-dd), schedule per weekday, `status` (active | cancelled | pending).
  - `billing/{id}`: **the bills, the heart of income.** Monthly bills are `{familyId}_{yyyy-mm}`. Fields:
    `familyId`, `periodLabel`, `periodStart`, `periodEnd`, `dueDate`, `total` (euros, **VAT-inclusive**),
    `lineItems[]` (`title`, `amount` net of discounts, `type`: study | transport | enrollment | event, discount
    and absence-credit breakdowns), `status`, `paymentMethod`, `paidAt`, `invoiceNumber`, `vendusId`,
    `createdAt`. `type` is absent on monthly bills; `party_deposit`, `camp_deposit`, `camp_balance` and `event`
    bills stand alone (a guest's event bill has `familyId` "").
  - Bill `status`: pending (not paid yet), processing (payment started), paid (payment confirmed), invoiced
    (paid and the Vendus invoice sent: **counts as paid**), failed, cancelled, dry-run (a test: never count it).
  - `bookings/{id}`: party bookings (`total` is **without VAT**). `camps`, `campSubscriptions`, `campDays`,
    `campBookings`: camps. `adhocEvents`, `adhocEventRegistrations`: one-off events.
  - `payments`, `emailOutbox`, `invoicePdfs`, `settings`, `config`: plumbing; rarely needed.
- FinHub (the group's finance app) keeps the companies' books under `finances_entities/{entity}/…` in the same
  projects: entity `noisyphocus` is KidClub's company. `finances_entities/noisyphocus/costSummary/{yyyy-mm}`
  holds the month's costs (`totalCostCents` with VAT, `totalNetCents` without, `payrollCostCents`,
  `softwareCostCents`, and a breakdown). Other collections there: `accounts`, `categories`, `recurring`,
  `employmentContracts`, `payrollRuns`, `forecastEvents`, `companies`, `people`.

## How to answer business questions
- **Income for a month**: sum `total` of `_apps/arcoiris/billing` with status paid or invoiced and the period
  in that month (gcloud_db_aggregate; two sums, or one per status). Say it's VAT-inclusive; for "sem IVA" say
  it's per line type (study, enrollment and insurance 23%, transport 6%, events 23%) or check Vendus's totals.
- **What's owed**: bills with status pending or failed whose `dueDate` has passed; name the families only when
  asked.
- **Costs and profit**: the month's `costSummary` doc; profit ≈ income (paid) − `totalCostCents`/100. Say
  which months have no cost summary yet (FinHub computes it when its Custos page is opened).
- **Clients**: active families = `families` with status active; children per service from the active
  subscriptions. A trend means comparing months, so run the same aggregate per month.
- **Invoices**: link a bill to Vendus through its `invoiceNumber` / `vendusId`, never through the client's name.
- Counting with gcloud_db_aggregate is cheap; reading documents costs more and is capped at 50 per query: read
  documents only to show a few examples or details.
- Numbers come from what a tool returned, with the month and environment named. Prod unless they say dev.
- For decisions, give the figures, what they suggest, and what's uncertain; the decision is theirs.
