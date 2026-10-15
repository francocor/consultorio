# Exploration: SaaS foundation rewrite

Source: read-only audit of the legacy `BackEnd/` and `FrontEnd/` (2026-10-15). The legacy code is reference material for domain knowledge and UI design. It is not a base to extend.

## Decision already taken

Rewrite on a new foundation, reusing domain knowledge and UI design. Rationale: authentication, tenancy, migrations and auditing cut across every table and endpoint, so they cannot be added on top of the current code.

## Legacy domain inventory

| Domain | What it does today |
|---|---|
| Auth / users | Username and password login with roles `admin`, `profesional`, `secretaria` (`master` is referenced but never created). Admin manages users, including password reset. |
| Profesionales | Profile with matricula, especialidad, avatar, obras sociales and pricing (`plus`, `particular`). |
| Horarios | Weekly working hours per professional, used to validate appointment slots. |
| Pacientes | Name, DNI, phone, email, birth date, sex, obra social, plus an anamnesis record (`pacienteInfo`: allergies, chronic conditions, habits, family history). Excel export. |
| Turnos | Appointments with paciente, doctor, fecha, especialidad, obra social and `cobro`, plus two state fields: `estado_asistencia` and `estado_atencion`. |
| Asistencias | The secretary marks the patient present or absent. Feeds the professional's "presentes" list. |
| Atención / historias clínicas | Encounter form (motivo, síntomas, parámetros, diagnóstico, tratamiento, medicamentos) with one optional file attachment stored as a BLOB. |
| Recetas | External links only (PAMI CUP, MisRx). No in-app prescribing. |
| Facturación | DB view over turnos with filters (doctor, obra social, dates, status) and XLSX/PDF export. |

Inferred legacy schema: `users`, `profesionales`, `profesional_horarios`, `pacientes`, `pacienteInfo`, `turnos`, `historias_clinicas`, and the views `vw_facturacion_turnos` and `vw_paciente_con_info`. The repo has no schema or migration files.

## Critical gaps (must be solved by the foundation)

- **No authentication or authorization.** The JWT is issued but never verified, and every endpoint is public: patient data, clinical records, user CRUD and billing.
- **Privilege escalation and account takeover.** `POST /register` is public and accepts `role` from the body. `reset-password` is public and sets the password to `1234`.
- **Client-controlled identity.** Billing trusts `?role=` and `?user_id=`. `creado_por` and `userId` are taken from the request body.
- **No tenancy.** No table has a clinic/organization key.
- **Health-data compliance (AR Ley 26.529 / 25.326).**
  - No audit trail.
  - No record versioning or immutability.
  - Hard delete of users orphans records.
  - No consent capture.
  - No retention policy.
- **File storage.** Files are BLOBs in MySQL with no size or type limits, and they are returned inside JSON lists.
- **Secrets and hygiene.**
  - `BackEnd/.env` is committed. Its secrets must be considered exposed and rotated.
  - About 18k `node_modules` files are tracked.
  - There is no `.gitignore`.
- **No tests, lint, CI, types or containerization.**

## Legacy bugs worth remembering (do not port)

- `turnosController.js:136` has a missing comma in the SQL, so `/turnos/vistos` always fails.
- `profesionalesController.js:33` uses an undefined `pool`.
- `putHorariosBulk` releases its pool connection twice.
- Frontend case-sensitive imports (`login/Login`, `ui/botonHarmonia`) break the build on Linux.
- `http://localhost:4000` is hardcoded in about 21 frontend files.

## UI worth reusing

- Role-based shells (profesional, secretaria, admin).
- Patient chart (ficha) with consultation and document lists.
- Encounter form.
- Anamnesis form.
- Appointment assignment with slot validation against working hours.
- Billing table with filters and export.
- The visual identity (blue gradient) should become a per-tenant theme, not hardcoded branding. Today three different names appear: Ayllu, Harmonia and Tordo.

## Duplication to collapse in the rewrite

- 3 sidebars and 2 layouts become one role-driven layout config.
- `TurnoPaciente` and `TurnoNuevoPaciente` share the same slot logic.
- `Atencion` and `AtencionCard` are duplicates.
- `AdminPanel` (573 lines) mixes fetching, rules and JSX.

## Product gaps for a sellable multi-specialty product

- Calendar views (day and week), blocks, overbooking, appointment types with durations, waitlist.
- Reminders and confirmation (WhatsApp / email) to reduce no-shows.
- Public online booking per professional.
- Specialty-configurable clinical record templates (odontogram, psychology, physiotherapy, nutrition).
- Integrated electronic prescription (AR Ley 27.553).
- Real billing: obras sociales, payments, daily cash, charts.
- Patient portal: documents, appointments, signed informed consent.
- Self-service tenant onboarding and subscription billing.
- Mobile-first / PWA usage.
