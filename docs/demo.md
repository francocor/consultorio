# The demo organization

"Centro Médico Aillu" is a fictitious medical center that ships with the product. It exists to show the whole Stage 2 product (scheduling, clinical records, documents and the guided first run) with realistic content, to run the browser test suite against, and to be reset to a known state in seconds. Nothing in it is real: names, documents, phones, emails and clinical notes are invented.

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

| Area          | Content                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Look          | The "Aillu" theme: green, rounded corners, Poppins headings                                                                                                                                                                                                                           |
| Locations     | Sede Central, Consultorios Norte, Sucursal Córdoba (another time zone)                                                                                                                                                                                                                |
| Team          | Seven accounts, one per row of the table above                                                                                                                                                                                                                                        |
| Professionals | Cardiology, pediatrics, psychology, each with a registration number (unverified) and weekly hours at different locations                                                                                                                                                              |
| Patients      | 26: documents `99.000.001` to `99.000.025` plus a newborn without a document; phones `+54 11 0000 xxxx`                                                                                                                                                                               |
| Coverage      | Seven enabled plans (OSDE 210/310, Swiss Medical, Galeno, Medifé, PAMI, IOMA); most patients have one, a few are "Particular"                                                                                                                                                         |
| Minors        | Four children with an administrative representative and the date to review it when they reach 18                                                                                                                                                                                      |
| Consent       | Everyone consented at registration except one patient, who shows the "consent pending" warning                                                                                                                                                                                        |
| Care          | Twelve assignments: patients are assigned to the three professionals, who recorded nine anamneses                                                                                                                                                                                     |
| Safety alerts | Raised by the anamneses: allergy, anticoagulant, pregnancy, implanted device. Reception sees only "consult the professional"                                                                                                                                                          |
| Agenda        | Appointment types, a block, a day off, a period with reduced hours and appointments around today (last week, today, next week) in every status, with the identity review waiting for reception                                                                                        |
| The day       | Consultations opened from the appointments of the agenda (decision D20): signed notes, one visit still in progress with its note as a draft, and an addendum on a signed note                                                                                                         |
| Documents     | Identity cards, a coverage card and a signed form (administrative), a lab result, an image, a referral and a report (clinical, attached to a visit); every file went through the real upload and the fake scanner, and one file the scanner refused shows what a rejection looks like |
| Clinical      | Twelve notes written through the real services: signed consultations of cardiology and pediatrics (general template) and psychology sessions (own template, one restricted to its author), an addendum, a note entered in error and a draft left open (see the drafts view)           |
| Audit trail   | Every step of the seed is in the audit log, so the viewer is not empty on the first visit                                                                                                                                                                                             |

Good paths to show:

1. **Reception** registers a patient (try a repeated document: the existing record is offered), adds coverage, assigns the patient to **Dra. Paz**.
2. **Dra. Paz** opens the patient, records an allergy; the alert appears for reception as "consult the professional", never the allergy.
3. **The owner** opens the audit trail, filters by that patient, exports it, and changes the branding: the new color is there after a reload, with no flash.
4. **Dra. Paz** opens the clinical chart of a patient (tab "Historia clínica"): signed notes with their addenda, the search of that record (try "hipertension" without the accent), the note entered in error behind "Mostrar las entradas marcadas como error", and a new consultation that saves by itself while she types. The pediatrician, who does not treat that patient, is told she has no access; reception and the owner have no such tab.
5. **A day in the center.** Reception opens the agenda, books a patient with the cardiologist, confirms and registers the arrival. The cardiologist opens the same appointment, presses "Iniciar consulta" (the patient is called in and the new encounter opens with the reason already filled in from the appointment), writes, signs, and adds an addendum; on the patient's "Documentos" tab uploads a lab result (it shows "Analizando", then "Disponible" within seconds) and downloads it. Reception, on the same tab, does not see the clinical file. `e2e/stage2-center.spec.ts` does exactly this.
6. In the **operator console**, create an organization and read the owner's invitation in Mailpit.
7. **The first run.** The demo organizations are already set up (their wizard is finished and their checklist is dismissed, so it opens on the agenda). To show what a new customer sees, create an organization in the operator console, accept the owner's invitation from Mailpit and sign in: the setup wizard opens by itself, with the quick setup for a solo professional (a consultorio ready to book in one screen) and the step by step for a center. The checklist "Primeros pasos" then sits on the start page and in the account menu.

## Resetting the demo

A demo organization can be put back to its starting content. It is the only place where the product deletes tenant data, and it is deliberately narrow:

- The database function `app.demo_reset` refuses unless the organization is flagged `is_demo` (fixed when it is created) and can only be run by the operator console's database role. The API and the worker cannot call it.
- It removes everything the organization holds, **including its audit trail**, and keeps the organization, its key and its feature flags. Other organizations are untouched and their audit chains still verify.
- The platform trail records `demo.chain_reset` with the sequence number and hash where the removed chain ended, as proof of the cut.
- With a bucket configured, the demo's files are removed from it and new ones are stored. The seed then fills the organization again (a few seconds, with the agenda, the consultations and the documents). Sessions end, so everyone is signed out.

```bash
pnpm demo:reset                 # organization "aillu", documented password
pnpm demo:reset --slug norte
pnpm demo:reset --rotate        # new random passwords, printed once
```

`demo:reset` needs `OPERATOR_DATABASE_URL`. The console has the same action ("Reiniciar la demostración") on every demonstration organization. A deployed demo rotates its passwords on every reset instead of using the public one.

## Safety rules the demo follows

- The seed refuses `NODE_ENV=production` with the public password and refuses any organization that is not flagged as a demo.
- Demo organizations never reach real services: the adapter resolver (`apps/api/src/main/adapter-resolver.ts`) gives them the fake email sender and refuses a configuration that would not.
- Demo organizations are exempt from billing.
- All data is deterministic: the same seed gives the same content, which is what makes the tests and the screenshots stable.
