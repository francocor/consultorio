-- Judgment day, Stage 4, round 1 (A-S2): a CAE is the answer of the authority to ONE voucher, so two
-- vouchers of an organization never share it. Nothing in the application or in the simulators
-- repeats one (the simulated CAE is a hash of the organization, the issuer, the point of sale, the
-- type and the number); a manual entry that repeats one is refused with `invoice_cae_taken`, and a
-- voucher the authority answers with a CAE we hold parks the invoice for a person.
CREATE UNIQUE INDEX "invoice_cae_key" ON "invoice" USING btree ("tenant_id","cae") WHERE "invoice"."cae" is not null;