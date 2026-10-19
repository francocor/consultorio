# The demo organization

"Centro Médico Aillu" is a fictitious medical center that ships with the product. It exists to show the whole product built so far (scheduling, clinical records, documents, the guided first run, the patient side of Stage 3: online booking, reminders, the waitlist and video visits, and Stage 4: prices, charges, cash registers, invoices and reports) with realistic content, to run the browser test suite against, and to be reset to a known state in seconds. Nothing in it is real: names, documents, phones, emails and clinical notes are invented.

## Run it on your machine

You need Docker (Postgres, MinIO, Mailpit) and the tools in [dev-setup.md](dev-setup.md). Two ways.

### 1. The throwaway stack (fastest, nothing to configure)

```bash
pnpm install
pnpm demo:stack                        # Postgres 17, MinIO, Mailpit, API, worker, two demo organizations, one operator
# in a second terminal, once the banner shows (it prints this exact line):
CSP_CONNECT_SOURCES=http://localhost:9100 API_PROXY_TARGET=http://127.0.0.1:3000 pnpm --filter @consultorio/web dev
```

`demo:stack` starts everything in Docker containers that disappear when you press Ctrl+C, seeds two organizations (`aillu`, green, and `norte`, blue: two hosts, two looks) and creates a platform operator. The banner it prints has every address and the operator's authenticator secret. This is also the stack the Playwright suite runs against.

The stack has the whole document pipeline: MinIO (published on port 9100, `--minio-port` changes it) receives the files the browser uploads, and the worker scans them with the fake scanner, which flags only the EICAR test string. `CSP_CONNECT_SOURCES` lets the dev server's Content Security Policy allow that storage address, because the browser sends the file straight to it.

### 2. Your own database (data survives restarts)

```bash
cp .env.example .env                   # placeholders; never commit .env
pnpm infra:up                          # Postgres, MinIO, Mailpit
pnpm --filter @consultorio/api db:migrate      # schema + platform catalogs (payers, holidays)
pnpm demo:seed                         # organization "aillu"; safe to run twice (it leaves existing data alone)
                                       # with S3_BUCKET set it also uploads and scans the demo documents
pnpm dev                               # API on :3000, web on :5173
```

Open **http://aillu.localhost:5173**. Browsers resolve `*.localhost` to your machine, so every organization has its own address, cookies and theme, as in production. `pnpm demo:seed --slug other` seeds a second organization.

## Sign in

The password is the same for every demo account and **public on purpose**: `Demo-Aillu-2026-clave`. It lives in `apps/api/src/db/seed/demo/credentials.ts` (marked dev-only), never in `.env`. The seed refuses to run with it when `NODE_ENV=production`.

| Email (all `@demo.invalid`) | Role                      | What to look at                                                              |
| --------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `propietaria@`              | Owner (Marcela Quiroga)   | Everything administrative: team, audit, branding, security, billing          |
| `administracion@`           | Admin (Tomás Beltrán)     | Same as the owner, minus the subscription                                    |
| `recepcion@`                | Reception, all locations  | Patients, registration, coverage, consent, assignments. No clinical content  |
| `recepcion.norte@`          | Reception, Norte location | The same, scoped to one location                                             |
| `cardiologia@`              | Professional (Dra. Paz)   | Her assigned patients and their anamnesis, with the safety alerts she raised |
| `pediatria@`                | Professional (Dr. Rivas)  | Children, representatives, allergies                                         |
| `psicologia@`               | Professional (Lic. Costa) | A professional whose notes stay private by default                           |

The addresses use the reserved `.invalid` domain (RFC 2606): nothing sent to them can be delivered. With the throwaway stack the second organization (`norte`) uses `<account>+norte@demo.invalid`.

### Platform operator

The operator console is a separate application on `platform.localhost:5173`. With `demo:stack` the operator is already there:

|          |                                                                      |
| -------- | -------------------------------------------------------------------- |
| Email    | `operador@demo.invalid`                                              |
| Password | `Operador-Demo-2026-clave`                                           |
| Code     | six digits from the secret printed in the banner (see the tip below) |

Tip: `TOTP_SECRET=<secret from the banner> pnpm --filter @consultorio/api operator:code` prints the current code, so no phone is needed.

With your own database create one (the only way, there is no endpoint):

```bash
OPERATOR_PASSWORD='a long passphrase of 14+ characters' \
  pnpm --filter @consultorio/api operator:create --email you@example.com --name "Your Name"
```

The secret is shown once. From the console you can list organizations, create one (its owner receives an invitation in Mailpit at http://localhost:8025), resend that invitation, and reset a demonstration organization.

## What the demo contains

| Area           | Content                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Look           | The "Aillu" theme: green, rounded corners, Poppins headings                                                                                                                                                                                                                                                                                                                        |
| Locations      | Sede Central, Consultorios Norte, Sucursal Córdoba (another time zone)                                                                                                                                                                                                                                                                                                             |
| Team           | Seven accounts, one per row of the table above                                                                                                                                                                                                                                                                                                                                     |
| Professionals  | Cardiology, pediatrics, psychology, each with a registration number (unverified) and weekly hours at different locations                                                                                                                                                                                                                                                           |
| Patients       | 26: documents `99.000.001` to `99.000.025` plus a newborn without a document; phones `+54 11 0000 xxxx`                                                                                                                                                                                                                                                                            |
| Coverage       | Seven enabled plans (OSDE 210/310, Swiss Medical, Galeno, Medifé, PAMI, IOMA); most patients have one, a few are "Particular"                                                                                                                                                                                                                                                      |
| Minors         | Four children with an administrative representative and the date to review it when they reach 18                                                                                                                                                                                                                                                                                   |
| Consent        | Everyone consented at registration except one patient, who shows the "consent pending" warning                                                                                                                                                                                                                                                                                     |
| Care           | Twelve assignments: patients are assigned to the three professionals, who recorded nine anamneses                                                                                                                                                                                                                                                                                  |
| Safety alerts  | Raised by the anamneses: allergy, anticoagulant, pregnancy, implanted device. Reception sees only "consult the professional"                                                                                                                                                                                                                                                       |
| Agenda         | Appointment types, a block, a day off, a period with reduced hours and appointments around today (last week, today, next week) in every status, with the identity review waiting for reception                                                                                                                                                                                     |
| The day        | Consultations opened from the appointments of the agenda (decision D20): signed notes, one visit still in progress with its note as a draft, and an addendum on a signed note                                                                                                                                                                                                      |
| Documents      | Identity cards, a coverage card and a signed form (administrative), a lab result, an image, a referral and a report (clinical, attached to a visit); every file went through the real upload and the fake scanner, and one file the scanner refused shows what a rejection looks like                                                                                              |
| Clinical       | Twelve notes written through the real services: signed consultations of cardiology and pediatrics (general template) and psychology sessions (own template, one restricted to its author), an addendum, a note entered in error and a draft left open (see the drafts view)                                                                                                        |
| Online booking | An enabled booking link for the organization and one per professional, each with a stable address a QR code can carry (see "Stage 3: the patient side"); three online bookings in the agenda: one confirmed for a person who registered themselves, one waiting for approval, and one made with the document of an existing patient, whose identity reception still has to confirm |
| Waitlist       | Five entries (three for cardiology, one of them paused, one for pediatrics and one for psychology): the first holds an open offer after letting an earlier one expire, two are kept for calling because the patient cannot be reached or did not accept offers, and two freed times are shown to reception to fill by phone                                                        |
| Video visits   | A video visit type and four virtual appointments about a month out: three with their room ready (a static address of the fake provider) and one whose room could not be made, waiting for a manual link                                                                                                                                                                            |
| Messages       | A log in every status (queued, sent, delivered, read, failed, cancelled) for reminders, confirmations, an offer and a video link; the choices of the patients behind it (WhatsApp accepted, left by writing BAJA, email left by the link); the provider events, two replies and the WhatsApp usage of the month                                                                    |
| Audit trail    | Every step of the seed is in the audit log, so the viewer is not empty on the first visit                                                                                                                                                                                                                                                                                          |

Good paths to show:

1. **Reception** registers a patient (try a repeated document: the existing record is offered), adds coverage, assigns the patient to **Dra. Paz**.
2. **Dra. Paz** opens the patient, records an allergy; the alert appears for reception as "consult the professional", never the allergy.
3. **The owner** opens the audit trail, filters by that patient, exports it, and changes the branding: the new color is there after a reload, with no flash.
4. **Dra. Paz** opens the clinical chart of a patient (tab "Historia clínica"): signed notes with their addenda, the search of that record (try "hipertension" without the accent), the note entered in error behind "Mostrar las entradas marcadas como error", and a new consultation that saves by itself while she types. The pediatrician, who does not treat that patient, is told she has no access; reception and the owner have no such tab.
5. **A day in the center.** Reception opens the agenda, books a patient with the cardiologist, confirms and registers the arrival. The cardiologist opens the same appointment, presses "Iniciar consulta" (the patient is called in and the new encounter opens with the reason already filled in from the appointment), writes, signs, and adds an addendum; on the patient's "Documentos" tab uploads a lab result (it shows "Analizando", then "Disponible" within seconds) and downloads it. Reception, on the same tab, does not see the clinical file. `e2e/stage2-center.spec.ts` does exactly this.
6. In the **operator console**, create an organization and read the owner's invitation in Mailpit.
7. **The first run.** The demo organizations are already set up (their wizard is finished and their checklist is dismissed, so it opens on the agenda). To show what a new customer sees, create an organization in the operator console, accept the owner's invitation from Mailpit and sign in: the setup wizard opens by itself, with the quick setup for a solo professional (a consultorio ready to book in one screen) and the step by step for a center. The checklist "Primeros pasos" then sits on the start page and in the account menu.

## Stage 3: the patient side

The demo organizations open on their Stage 3 data. Nothing in it was sent: a demonstration organization never reaches a real service, so the message log is data written by the seed, and any message the worker meets for a demonstration organization is cancelled with the reason "organización de demostración: no se envía".

**The public booking address.** Each organization has a page that anybody can open, with no account, at an address derived from its slug, so it is the same after every reset and on every machine:

| Organization | Address (dev server on port 5173)               |
| ------------ | ----------------------------------------------- |
| `aillu`      | `http://aillu.localhost:5173/book/wfg3xazkdesq` |
| `norte`      | `http://norte.localhost:5173/book/mh4p4sxuiq7j` |

Under it each professional has a page of their own: for `aillu`, `/book/wfg3xazkdesq/p/exijd7fnx6bd` (cardiology), `/p/utz3dh6ghsgx` (pediatrics) and `/p/79t6mfxadwpa` (psychology). The owner finds the same addresses, with their QR codes, in Settings > Turnos online. Open the page in a 360 px window to see it as a patient does.

**1. Book as a patient.** Open the address, choose "Dra. Lucía Paz Ferrer", pick a time and fill the form; the six-digit code arrives in Mailpit (the banner of `pnpm demo:stack` prints its address). The demo does not require approval, so the confirmation says the appointment is booked, with a link to change or cancel it.

**2. Reception.** Sign in as `recepcion@`. Pendientes holds the bookings that need a person: "Reserva por aprobar" (approve it with "Aprobar turno") and two "Identidad por confirmar" (open the record, read the differences between what the visitor typed and what the file says, and confirm after seeing the document). The Lista de espera screen shows the open offer, the entries kept for calling, and "Turnos para ofrecer por teléfono": the freed times nobody could be offered by message.

**3. Video visits.** In the agenda, about a month out, the virtual appointments carry a marker. Open one as the owner or the professional: the panel "Videoconsulta" says the room is ready and offers "Entrar a la videoconsulta" only inside the join window (from 15 minutes before the start). The cardiology one without a room says "Falta el enlace de la videoconsulta": "Adjuntar enlace manual" takes a link from an allowed service. In a real organization, a patient whose confirmation said that the link would follow then receives a message with it (a demonstration organization sends nothing).

**4. Messages.** A patient's tab "Mensajes" shows what they accepted (WhatsApp accepted in person or by their own link, left by writing BAJA, email left by the link in a message). The appointment drawer lists the messages sent for it, with their status and the reason of the ones that were not sent.

**5. See the messages travel.** The platform console (`platform.localhost:5173`, operator `operador@demo.invalid`) has Proveedores > "WhatsApp (simulador)": the phone that receives the WhatsApp messages of real organizations, where you can type a reply such as BAJA or 1. It stays empty for the demonstration organizations. To watch a reminder arrive on it, create an organization in the console (the owner's invitation lands in Mailpit), book there and resend the reminder from the appointment. `apps/web/e2e/stage3-demo.spec.ts` is that whole journey, automated:

```bash
pnpm --filter @consultorio/web exec playwright test e2e/stage3-demo.spec.ts --project=desktop
```

It books online, approves the booking, sends the reminder to the simulator and the mailbox, confirms with the link, writes BAJA, makes a video visit whose link follows, joins it, and offers a cancelled time to the waitlist, checking accessibility at 360 px and at 1280 px on every screen.

## Stage 4: billing, cash, invoices and reports

The demo organizations open on their Stage 4 data. All of it was written through the same services the API runs (so the rules are the real ones and every step is in the audit trail), and nothing leaves the process: the invoices go through an in-memory fake of AFIP, the payments are recorded by hand, and every voucher says it is a test document with no fiscal validity.

| Area           | Content                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prices         | A private price for each type of appointment, an older list and the current one (10% higher); payer prices for OSDE (plans 210 and 310 differ), Swiss Medical and Galeno, with the copago and the plus the patient adds                                                                                                                                                |
| Payers         | OSDE and Swiss Medical with a CUIT, Galeno without one (its invoice is refused with a pointer to the payer settings), PAMI on the list with no price (its patients are charged the private price, and the screen says why), Medifé switched off                                                                                                                        |
| Charges        | One for every visit of the last two weeks that can be charged: pending, partly paid, paid and voided (with the reason); fees for the visits that did not happen (some paid, some forgiven, some flagged for a person to look at); the payer's part kept apart from what the patient owes                                                                               |
| Payments       | Every method (cash, debit, credit, transfer, wallet, payment link) with voucher numbers, a card voucher split in two payments with the reason, a payment above the amount owed kept as a credit, a few refunds and one correction made after the register had closed                                                                                                   |
| Cash registers | One per place and day: closed with the cash counted (one short, one over, each with its reason), and one open today at each desk of reception. The Córdoba branch has no reception, so the administration takes the money there                                                                                                                                        |
| Invoices       | Facturas C issued (some for a part of a charge), invoices to OSDE and Swiss Medical over their portion of several visits, two credit notes (partial and total), a rejected invoice left so, one rejected and issued again, and one registered by hand in place of an invoice that stayed pending. The latest paid visits are left for reception to invoice (see below) |
| Reports        | The money and cash reports add up to exactly this data (a test compares them with the tables); the operational dashboard reads the same agenda                                                                                                                                                                                                                         |

Not in the seed: an invoice flagged as a prolonged outage. That flag is computed from the age of a pending invoice, and an invoice cannot be written with an old date (the database stamps it with the transaction time), so the demo shows it live, in step 5.

**1. The day at the front desk.** Sign in as `recepcion@`. In Caja (menu), choose the place: the register of today is open, with the cash it should hold. Press "Cerrar caja", count (type the amount shown to close it exactly, or a different one to see that a reason is required) and confirm. The day moves to "Cajas anteriores", and a payment in cash is now refused until a register is opened again. The closed days of the last two weeks show two counts that did not match, with the reason someone wrote.

**2. Charges.** Cobros lists the charges of a period (it opens on today: widen "Desde" to see the week). Open one to see its lines, its payments and, for the owner or an administrator, "Devolver" and "Anular cobro" (reception sees who can do it, and the API refuses the call). The tab "A cobrar a obras sociales" adds up what the payers owe.

**3. Prices and payers.** As `administracion@`, Ajustes > Precios y obras sociales: the payers with and without a CUIT, the price history and what each plan pays. Press the CUIT button of Galeno, load a valid CUIT, and its invoices become possible.

**4. An invoice.** As reception, Facturas > "Cobros por facturar": the paid visits that nothing has invoiced yet. "Facturar el cobro de ..." asks for the amount (all of it, or a part) and the invoice is issued with a CAE, a number that follows the vouchers the seed left, and a PDF that the worker builds a few seconds later ("Descargar PDF" in the detail of the voucher). The owner can issue a credit note from the same detail; reception cannot.

**5. An outage of AFIP.** In the platform console (`platform.localhost:5173`), Proveedores > AFIP, put the issuer of the demonstration in "down". Invoice another charge: it stays "Todavía no se emitió" and nothing is invented. Put it back in "ok": within a minute or two the clock of the retries issues it, once, with the next number. A pending invoice older than the threshold of the organization (24 hours by default, in Ajustes > Facturación) is flagged and offers the owner to register the voucher by hand.

**6. Reports.** Reportes opens the operational dashboard; its "Dinero" and "Caja" screens (the money and cash reports) have the totals, the breakdown by place, professional, payer and type (a chart and a table each), the drill-down to the records behind each figure and the export. Reception reads the places it works at and never revenue by professional; a professional reads only their own appointments.

Steps 1, 4 and 5, automated and checked at 360 px:

```bash
pnpm --filter @consultorio/web exec playwright test e2e/stage4-demo.spec.ts --project=desktop
```

It looks at every screen of billing, cash, invoices and reports with this data in them (wide tables, long lists, vouchers of every kind), closes the register of the day in the second organization, issues an invoice, checks that its PDF is a real PDF, rides out an outage and checks that the invoice is issued once after it.

## Resetting the demo

A demo organization can be put back to its starting content. It is the only place where the product deletes tenant data, and it is deliberately narrow:

- The database function `app.demo_reset` refuses unless the organization is flagged `is_demo` (fixed when it is created) and can only be run by the operator console's database role. The API and the worker cannot call it.
- It removes everything the organization holds, **including its audit trail**, and keeps the organization, its key and its feature flags. Other organizations are untouched and their audit chains still verify.
- The platform trail records `demo.chain_reset` with the sequence number and hash where the removed chain ended, as proof of the cut.
- With a bucket configured, the demo's files are removed from it and new ones are stored. The seed then fills the organization again (about ten seconds, with the agenda, the consultations, the documents, the charges and the invoices). Sessions end, so everyone is signed out.

```bash
pnpm demo:reset                 # organization "aillu", documented password
pnpm demo:reset --slug norte
pnpm demo:reset --rotate        # new random passwords, printed once
```

`demo:reset` needs `OPERATOR_DATABASE_URL`. The console has the same action ("Reiniciar la demostración") on every demonstration organization. A deployed demo rotates its passwords on every reset instead of using the public one.

## Safety rules the demo follows

- The seed refuses `NODE_ENV=production` with the public password and refuses any organization that is not flagged as a demo.
- Demo organizations never reach real services: the adapter resolver (`apps/api/src/main/adapter-resolver.ts`) gives them the fake email sender, the fake WhatsApp sender, the fake video provider and the fake bot challenge, and refuses a configuration that would not. The Stage 3 seed writes rows and queues nothing.
- The in-memory fake of AFIP lives in each process. The demonstration stack runs the API and the worker in one process, so the "down" mode that the platform console sets is the one the worker's retries see; a deployment that runs them as two processes (`main.ts api` and `main.ts worker`) has two fakes, and the console reaches only the one of the API process. Until the fake keeps its mode in Postgres like the local simulator does, put a demonstration in an outage with the stack of this page, not in a split deployment (judgment day Stage 4 round 1, A-T9).
- The invoices of the Stage 4 seed go through an in-memory fake of AFIP and hold no certificate; the payments are rows written by the seed. A demonstration organization cannot reach a real fiscal service even if the configuration says so.
- Demo organizations are exempt from billing.
- All data is deterministic: the same seed gives the same content, which is what makes the tests and the screenshots stable.
