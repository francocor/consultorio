/** Deliberately wrong: patient data written to storage that outlives the session. */
export function remember(patients: unknown) {
  window.localStorage.setItem('patients', JSON.stringify(patients));
  sessionStorage.setItem('last', 'x');
}
