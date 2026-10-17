/** Deliberately wrong: user-facing text written straight into the markup. */
export function LiteralText() {
  return (
    <div>
      <button type="button" title="Guardar cambios">
        Guardar
      </button>
      <p>{'Sin resultados'}</p>
    </div>
  );
}
