-- Judgment day, Stage 4, round 5 (suspect B-W2). A credit note made outside the system can now be
-- registered in place of one that was parked for a person (`status = 'manual'`), so the amount a charge
-- line has invoiced takes back what a REGISTERED credit note covers as well as an issued one. Only the
-- condition on the status of a credit note changes; the function is the one of 0491 otherwise. A note
-- that is pending, parked or rejected still releases nothing. 0491 is not edited.
CREATE OR REPLACE FUNCTION app.refresh_invoiced(p_tenant uuid, p_line uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$
  BEGIN
    -- A statement of its own: the UPDATE below starts after the lock is held and reads current data.
    PERFORM 1 FROM charge_line WHERE tenant_id = p_tenant AND id = p_line FOR UPDATE;
    UPDATE charge_line SET invoiced_cents = (
      SELECT coalesce(sum(CASE WHEN i.type IN ('NCA', 'NCB', 'NCC') THEN -il.amount_cents
                               ELSE il.amount_cents END), 0)
        FROM invoice_line il
        JOIN invoice i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
       WHERE il.tenant_id = p_tenant AND il.charge_line_id = p_line
         AND CASE WHEN i.type IN ('NCA', 'NCB', 'NCC') THEN i.status IN ('issued', 'manual')
                  ELSE i.status IN ('pending', 'issued', 'manual') END
    )
    WHERE tenant_id = p_tenant AND id = p_line;
  END
  $$;
